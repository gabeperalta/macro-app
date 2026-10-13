# Feedback-driven nutrition estimates — spec

Status: design only. Nothing is deployed, and goals and meal_items data are untouched.

## Current state (verified)
- `meal_items`: id, user_id, eaten_at, description (the user's raw text), name (one food per row), protein, carbs, fat, calories, calories_source, sodium_mg, sugar_g, sat_fat_g.
- The pencil edit runs `update(vals)` on meal_items (app.js:124). New rows come from the `parse-meal` Edge Function (Gemini plus OFF/USDA), then `insert` (app.js:267).
- Gap: the model's original numbers aren't kept, so after the first edit the original estimate is lost.

## 1. Migration (`supabase/feedback.sql`)
```sql
create extension if not exists pg_trgm;

-- keep the model's first estimate on every item
alter table meal_items
  add column if not exists est_protein numeric, add column if not exists est_carbs numeric,
  add column if not exists est_fat numeric,     add column if not exists est_calories numeric;
-- backfill: existing rows' current values become their "estimate" (no corrections exist yet)
update meal_items set est_protein=protein, est_carbs=carbs, est_fat=fat, est_calories=calories
 where est_protein is null;

create table estimation_feedback (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references auth.users on delete cascade,
  username      text not null,                 -- e.g. gabeperalta (from email prefix)
  meal_item_id  bigint references meal_items on delete set null,
  food_name     text not null,                 -- meal_items.name
  food_key      text not null,                 -- normalized name used for matching
  description   text,                          -- original free text
  orig_calories numeric, orig_protein numeric, orig_carbs numeric, orig_fat numeric,  -- model's estimate
  new_calories  numeric, new_protein  numeric, new_carbs  numeric, new_fat  numeric,  -- user's correction
  source        text not null default 'manual_edit' check (source in ('manual_edit','correction_pass')),
  active        boolean not null default true,  -- false = outdated/superseded
  created_at    timestamptz not null default now()
);
create index on estimation_feedback using gin (food_key gin_trgm_ops);
create index on estimation_feedback (user_id, active, created_at desc);

alter table estimation_feedback enable row level security;
-- shared: any approved user's session can read all corrections; writes still only for your own rows
create policy fb_read_all on estimation_feedback for select
  using (exists (select 1 from profiles p where p.id=auth.uid() and p.approved));
create policy fb_write_own on estimation_feedback for insert
  with check (user_id = auth.uid());
```
`food_key` = `lower(name)` with punctuation and quantity words removed ("2 slices", "oz", "g", "cup"…) and extra spaces collapsed, via a SQL function `norm_food(text)`. The Edge Function uses the same rule.

## 2. Automatic hook (DB trigger, so there's no app change and no manual step)
```sql
create or replace function meal_item_feedback() returns trigger language plpgsql security definer as $$
begin
  if (new.protein, new.carbs, new.fat, new.calories) is distinct from
     (old.protein, old.carbs, old.fat, old.calories) then
    -- a newer correction for the same item supersedes the earlier one
    update estimation_feedback set active=false where meal_item_id=new.id and active;
    insert into estimation_feedback(user_id, username, meal_item_id, food_name, food_key, description,
      orig_calories, orig_protein, orig_carbs, orig_fat, new_calories, new_protein, new_carbs, new_fat, source)
    select new.user_id, split_part(u.email,'@',1), new.id, new.name, norm_food(new.name), new.description,
      coalesce(old.est_calories,old.calories), coalesce(old.est_protein,old.protein),
      coalesce(old.est_carbs,old.carbs), coalesce(old.est_fat,old.fat),
      new.calories, new.protein, new.carbs, new.fat,
      coalesce(current_setting('macro.fb_source', true), 'manual_edit')
    from auth.users u where u.id = new.user_id;
  end if;
  return new;
end $$;
create trigger trg_meal_feedback after update on meal_items for each row execute function meal_item_feedback();
```
- On insert, the app (or a `before insert` trigger) copies the model's values into `est_*`.
- `orig_*` is always the model's first estimate, not an earlier correction.
- A bulk "correction pass" runs `set local macro.fb_source='correction_pass'` before its updates.
- Retention: the existing 12-month cron also deletes feedback rows older than 12 months.

## 3. Similarity lookup (pg_trgm, which is free, with no embeddings API)
An RPC that `parse-meal` calls once per parsed food name, before finalizing numbers:
```sql
create or replace function match_feedback(p_name text, p_limit int default 3)
returns table(username text, food_name text, orig_protein numeric, orig_carbs numeric, orig_fat numeric, orig_calories numeric,
              new_protein numeric, new_carbs numeric, new_fat numeric, new_calories numeric,
              sim real, age_days int, score real)
language sql stable as $$
  select username, food_name, orig_protein, orig_carbs, orig_fat, orig_calories,
         new_protein, new_carbs, new_fat, new_calories,
         similarity(food_key, norm_food(p_name)) sim,
         extract(day from now()-created_at)::int age_days,
         similarity(food_key, norm_food(p_name)) * exp(-extract(epoch from now()-created_at)/86400/60.0) score
  from estimation_feedback
  where active and food_key % norm_food(p_name)  -- all users; trigram threshold (default 0.3)
  order by score desc limit p_limit
$$;
```
- Match only when sim ≥ 0.5. Treat sim ≥ 0.8 as a "strong" match.
- Feedback is shared. Matching searches every user's active corrections, and each match carries the correcting username.
- Upgrade path: add a `vector(768)` column filled by Gemini `text-embedding-004` (free tier), and use cosine similarity when trigram misses synonyms ("salmon fillet" vs "grilled salmon"). This isn't needed for v1.

## 4. Recency and staleness
- The score is similarity × 0.5^(age/≈42 days), via an e-folding time of 60 days. A new correction outranks an old one for the same food.
- `active=false` marks a row outdated. It's set automatically when the same item is corrected again, or when a newer correction for the same `food_key` differs by more than 25% (optional, run inside the trigger).
- Rows older than 180 days are ignored in the RPC (`created_at > now()-interval '180 days'`).
- Possible later UI: a long-press on an item with "forget my correction". Not part of this change.

## 5. Prompt injection (parse-meal)
Flow:
1. Gemini splits the text into foods (as today).
2. For each food, call `match_feedback`.
3. If there's a match, send a second, narrow call, or include the block in the single call if names are known up front:
```
USER CORRECTIONS (past edits by app users — treat as strong evidence):
- "grilled salmon" (similarity 0.86, 12 days ago): model said P20 C0 F8 260kcal;
  user gabeperalta corrected P20 to P40, F8 to F14, 260kcal to 410kcal.
Rules: if the current food is the same item, start from the corrected values and scale only
for clearly different quantity. If it's a different preparation or portion, use judgment
and say so in "note". Never copy a correction for an unrelated food.
```
- Return a `feedback_applied: true/false` flag per item. The app could store it in `calories_source` (e.g. 'feedback') or in a new `est_source` column.
- Safety: put corrections in their own clearly labeled block, as quoted data. Cap at 3 per food and 10 per request.

## Migration steps
1. Run `feedback.sql` (extension, columns, backfill, table, RLS, norm_food, trigger, match_feedback) through the Management API.
2. In app.js insert: add `est_protein/carbs/fat/calories` = the model values. That's one line in the rows map.
3. In parse-meal: create a service client and call `match_feedback(name)`, which searches all users' corrections. Add the correction block to the prompt and redeploy.
4. Update the retention cron to delete feedback older than 12 months.
5. Test: edit a salmon entry from 20g to 40g protein and confirm a feedback row appears. Log "salmon" again and confirm the estimate is about 40g with `feedback_applied`.
6. Bump the sw cache and `?v`, then publish.
