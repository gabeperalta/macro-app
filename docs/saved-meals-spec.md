# Saved meals — spec

Status: implemented and published (v34; v33 shipped the first version). Tables created via `supabase/saved_meals.sql`; no saved meals or food entries were created for any user. Goals and existing meal_items rows are untouched.

## Current state (verified)
- `meal_items`: id, user_id, eaten_at, description, name, protein, carbs, fat, calories, calories_source, sodium_mg, sugar_g, sat_fat_g, est_protein/est_carbs/est_fat/est_calories.
- New rows come from the parse path in `chatForm.onsubmit` (app.js), which inserts one row per food with `est_*` = the saved values, then calls `refresh()`.
- The estimation-feedback trigger fires only on UPDATE of values, so inserting a saved meal creates no feedback rows.
- The Goals button sits in `.todayhead` (index.html:41) and opens `#goalsForm`, a `.card` panel.

## ★ Saved meals are verified training data
Logging a saved meal is a deliberate act: the user typed each item, its serving (e.g. "1 cup 2% milk") and its macros. That's stronger evidence than an AI guess or a one-off edit, so each logged saved-meal item becomes **high-confidence, shared** estimation feedback.

- **Feedback is shared across all users**: a saved meal informs everyone's estimates for that food, labeled with whose it was.
- **Path:** the app calls the RPC `log_saved_meal(p_saved_meal_id)` (security definer). In one transaction it checks the caller owns the meal and is approved, inserts the `meal_items` rows (`calories_source='saved_meal'`, `est_*` = values), and upserts one `estimation_feedback` row per saved item: `source='saved_meal'`, `confidence='high'`, `saved_meal_item_id`, `food_name` = full item name (serving kept), `food_key = norm_food(name)` (serving stripped, for matching), `new_*` = item macros, `orig_*` = null (no AI estimate).
- **No spoofing:** `fb_write_own` now only lets clients insert `source<>'saved_meal'`, `confidence='normal'`, no `saved_meal_item_id`. Verified rows only come from the RPC.
- **Dedupe:** unique partial index on `saved_meal_item_id where active`. Re-logging updates `created_at` (recency) and values instead of adding rows.
- **Staleness:** a `before update or delete` trigger on `saved_meal_items` (`saved_item_retire_fb`) sets `active=false` when an item's name/macros change or it's deleted (deleting a meal cascades to its items).
- **Matching:** `match_feedback` returns `source` and `confidence`; high confidence scores ×1.5. The 0.5 similarity threshold, 180-day window and 60-day decay are unchanged.
- **Prompt:** parse-meal labels these `VERIFIED by user <username> via saved meal (exact serving: "...")` and tells the model to treat them as ground truth for the same food and serving and scale linearly for other stated amounts.
- **Edits:** editing a logged saved-meal item in Today's items still writes a normal `manual_edit` correction through the existing trigger.
- Migration: `supabase/saved_meals_feedback.sql`.

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
- **Header menu** (v34): a compact ☰ button (`#actBtn`, `aria-label="Menu"`) sits centered in the top header between "Macro Log" and the username. It opens a small dropdown (`#actMenu`) with **Goals** and **Saved meals**. Each opens its existing panel (same `#goalsBtn` / `#savedBtn` handlers) and scrolls it into view. The dropdown closes on a choice or an outside tap. The old Goals and Saved meals buttons in the Today heading were removed.
- **Saved meals panel** (`#savedForm`, a `.card` like the goals panel): meal name, then rows of Item / P / C / F / kcal (kcal optional, placeholder "auto"), ✕ to remove a row, "+ Add item", Save meal / Cancel. Below that: the user's saved meals with item count and totals, each with ✕ delete (confirm prompt).
- **Choose saved meal** (`#pick`, bookmark icon, `aria-label="Choose saved meal"`, same `.mic` icon style) sits between the mic and Send. It toggles `#pickList` under the input. Empty state: "No saved meals yet".

## Editing a saved meal (v39)
- **UI:** each saved meal row has a pencil (same style as Today's items) next to ✕. It opens the same builder prefilled: name plus one row per item, each row carrying `data-id`. The header reads "Edit saved meal" and Save reads "Save changes". Cancel resets the builder to create mode, and deleting the meal being edited also resets it.
- **RPC** `update_saved_meal(p_id bigint, p_name text, p_items jsonb)`, security definer, in `supabase/saved_meals_edit.sql`. In one transaction it:
  - checks the caller is approved and owns the meal, and that the name and at least one item are present;
  - renames the meal;
  - updates items with an `id` (name, macros, calories, position = array order) and rejects ids that belong to another meal;
  - inserts items without an `id`;
  - deletes the meal's items that aren't in the list.
  Blank calories become 4P+4C+9F, the same as create.
- **Verified feedback:** the existing `saved_item_retire_fb` trigger deactivates the verified row of any item whose name or macros changed, or that was deleted. Unchanged items keep their row. The next log of the meal creates fresh verified rows for the changed items.
- The create path is unchanged (direct inserts).

## 3. Logging behavior
One tap on a meal in the picker calls `log_saved_meal(id)`, which inserts one `meal_items` row per saved item (and the verified feedback above):
`user_id`, `eaten_at` = now, `description` = saved meal name, `name`, `protein`, `carbs`, `fat`, `calories`, `calories_source = 'saved_meal'`, `est_*` = same values.
Then `refresh()` runs, so totals, Goal Met!, Records, and charts update. Items can be edited/deleted in Today's items like any other entry (edits write a `manual_edit` correction as usual).

## 4. Retention
Saved meals are templates, so the 12-month cleanup does not touch them. Logged items follow the normal meal_items retention.

## 5. Migration steps
1. Run `supabase/saved_meals.sql` (done; re-runnable).
2. Verify RLS: owner insert/select works for an approved user; other users and anon are denied (done, inside rolled-back transactions).
3. Ship index.html / app.js / styles.css; bump `sw.js` cache and `?v=` (33, then 34).
3b. Run `supabase/saved_meals_feedback.sql` and redeploy `parse-meal` (done).
4. Close and reopen the PWA to pick up the update.

## Code locations
- app.js: saved meals block starting at line 254.
- index.html: header menu `#actBtn`/`#actMenu` (lines 19–21), `#savedForm` after `#goalsForm`, `#pick` and `#pickList` in the Log food card.
- styles.css: `.headbtns`, `.smhead`, `.smrow`, `#pickList` at the end.
