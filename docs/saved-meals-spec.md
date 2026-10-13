# Saved meals — spec

Status: implemented and published (v33). Tables created via `supabase/saved_meals.sql`; no saved meals or food entries were created for any user. Goals and existing meal_items rows are untouched.

## Current state (verified)
- `meal_items`: id, user_id, eaten_at, description, name, protein, carbs, fat, calories, calories_source, sodium_mg, sugar_g, sat_fat_g, est_protein/est_carbs/est_fat/est_calories.
- New rows come from the parse path in `chatForm.onsubmit` (app.js), which inserts one row per food with `est_*` = the saved values, then calls `refresh()`.
- The estimation-feedback trigger fires only on UPDATE of values, so inserting a saved meal creates no feedback rows.
- The Goals button sits in `.todayhead` (index.html:41) and opens `#goalsForm`, a `.card` panel.

## 1. Migration (`supabase/saved_meals.sql`)
```sql
-- Saved meals (owner-only, approved users). Safe to re-run.
create table if not exists public.saved_meals (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name       text not null check (length(trim(name)) between 1 and 100),
  created_at timestamptz not null default now()
);
create table if not exists public.saved_meal_items (
  id            bigint generated always as identity primary key,
  saved_meal_id bigint not null references public.saved_meals(id) on delete cascade,
  name          text not null check (length(trim(name)) between 1 and 200),
  protein       numeric not null default 0 check (protein >= 0),
  carbs         numeric not null default 0 check (carbs >= 0),
  fat           numeric not null default 0 check (fat >= 0),
  calories      numeric check (calories >= 0),
  position      int not null default 0
);
create index if not exists saved_meals_user_idx on public.saved_meals(user_id);
create index if not exists saved_meal_items_meal_idx on public.saved_meal_items(saved_meal_id);
alter table public.saved_meals enable row level security;
alter table public.saved_meal_items enable row level security;
revoke all on public.saved_meals, public.saved_meal_items from anon;
grant select, insert, update, delete on public.saved_meals, public.saved_meal_items to authenticated;
drop policy if exists "own saved meals" on public.saved_meals;
create policy "own saved meals" on public.saved_meals for all to authenticated
  using (auth.uid() = user_id and exists (select 1 from public.profiles where id = auth.uid() and approved))
  with check (auth.uid() = user_id and exists (select 1 from public.profiles where id = auth.uid() and approved));
drop policy if exists "own saved meal items" on public.saved_meal_items;
create policy "own saved meal items" on public.saved_meal_items for all to authenticated
  using (exists (select 1 from public.saved_meals m join public.profiles p on p.id = m.user_id
                 where m.id = saved_meal_id and m.user_id = auth.uid() and p.approved))
  with check (exists (select 1 from public.saved_meals m join public.profiles p on p.id = m.user_id
                 where m.id = saved_meal_id and m.user_id = auth.uid() and p.approved));
```
- `saved_meal_items` has no user_id; RLS reaches ownership through the parent meal. Deleting a meal cascades to its items.
- `calories` is stored at save time (typed value, or 4P+4C+9F when left blank).

## 2. UI
- **Saved meals button** (`#savedBtn`, `secondary small`, same as Goals) sits left of 🎯 Goals in the Today header. It opens `#savedForm`, a `.card` panel like the goals panel:
  - Meal name, then rows of Item / P / C / F / kcal (kcal optional, placeholder "auto"), ✕ to remove a row, "+ Add item", Save meal / Cancel.
  - Below: the user's saved meals with item count and totals, each with ✕ delete (confirm prompt).
- **Choose saved meal** (`#pick`, bookmark icon, `aria-label="Choose saved meal"`, same `.mic` icon style) sits between the mic and Send. It toggles `#pickList` under the input; empty state "No saved meals yet".

## 3. Logging behavior
One tap on a meal in the picker inserts one `meal_items` row per saved item:
`user_id`, `eaten_at` = now, `description` = saved meal name, `name`, `protein`, `carbs`, `fat`, `calories`, `calories_source = 'saved_meal'`, `est_*` = same values.
Then `refresh()` runs, so totals, Goal Met!, Records, and charts update. Items can be edited/deleted in Today's items like any other entry (edits feed estimation_feedback as usual).

## 4. Retention
Saved meals are templates, so the 12-month cleanup does not touch them. Logged items follow the normal meal_items retention.

## 5. Migration steps
1. Run `supabase/saved_meals.sql` (done; re-runnable).
2. Verify RLS: owner insert/select works for an approved user; other users and anon are denied (done, inside rolled-back transactions).
3. Ship index.html / app.js / styles.css; bump `sw.js` cache and `?v=` to 33.
4. Close and reopen the PWA to pick up the update.

## Code locations
- app.js: saved meals block starting at line 251.
- index.html: `#savedBtn`/`#savedForm` (lines 41–52), `#pick` and `#pickList` in the Log food card.
- styles.css: `.headbtns`, `.smhead`, `.smrow`, `#pickList` at the end.
