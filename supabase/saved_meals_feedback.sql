-- Saved meals are verified training data for shared estimation feedback. Safe to re-run.
alter table public.estimation_feedback drop constraint if exists estimation_feedback_source_check;
alter table public.estimation_feedback add constraint estimation_feedback_source_check
  check (source in ('manual_edit','correction_pass','saved_meal'));
alter table public.estimation_feedback
  add column if not exists confidence text not null default 'normal',
  add column if not exists saved_meal_item_id bigint references public.saved_meal_items(id) on delete set null;
alter table public.estimation_feedback drop constraint if exists estimation_feedback_confidence_check;
alter table public.estimation_feedback add constraint estimation_feedback_confidence_check check (confidence in ('normal','high'));
-- one active row per saved meal item (re-logging refreshes it)
create unique index if not exists estimation_feedback_saved_item_active
  on public.estimation_feedback (saved_meal_item_id) where active and saved_meal_item_id is not null;

-- Clients can't spoof verified rows: direct inserts must be normal manual/correction rows.
drop policy if exists fb_write_own on public.estimation_feedback;
create policy fb_write_own on public.estimation_feedback for insert
  with check (user_id = auth.uid() and source <> 'saved_meal' and confidence = 'normal' and saved_meal_item_id is null);

-- Log a saved meal: inserts meal_items + upserts verified feedback atomically. Returns rows inserted.
create or replace function public.log_saved_meal(p_saved_meal_id bigint) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare uid uuid := auth.uid(); m record; it record; uname text; n int := 0; now_ts timestamptz := now(); mid bigint;
begin
  if uid is null or not exists (select 1 from profiles where id = uid and approved) then raise exception 'not allowed'; end if;
  select * into m from saved_meals where id = p_saved_meal_id and user_id = uid;
  if not found then raise exception 'saved meal not found'; end if;
  select split_part(email, '@', 1) into uname from auth.users where id = uid;
  for it in select * from saved_meal_items where saved_meal_id = m.id order by position, id loop
    insert into meal_items(user_id, eaten_at, description, name, protein, carbs, fat, calories, calories_source,
                           est_protein, est_carbs, est_fat, est_calories)
    values (uid, now_ts, m.name, it.name, it.protein, it.carbs, it.fat,
            coalesce(it.calories, round(4*it.protein + 4*it.carbs + 9*it.fat, 1)), 'saved_meal',
            it.protein, it.carbs, it.fat, coalesce(it.calories, round(4*it.protein + 4*it.carbs + 9*it.fat, 1)))
    returning id into mid;
    insert into estimation_feedback(user_id, username, meal_item_id, food_name, food_key, description,
      orig_calories, orig_protein, orig_carbs, orig_fat, new_calories, new_protein, new_carbs, new_fat,
      source, confidence, saved_meal_item_id, active, created_at)
    values (uid, uname, mid, it.name, norm_food(it.name), m.name, null, null, null, null,
      coalesce(it.calories, round(4*it.protein + 4*it.carbs + 9*it.fat, 1)), it.protein, it.carbs, it.fat,
      'saved_meal', 'high', it.id, true, now_ts)
    on conflict (saved_meal_item_id) where active and saved_meal_item_id is not null
    do update set created_at = excluded.created_at, meal_item_id = excluded.meal_item_id, food_name = excluded.food_name,
      food_key = excluded.food_key, description = excluded.description, new_calories = excluded.new_calories,
      new_protein = excluded.new_protein, new_carbs = excluded.new_carbs, new_fat = excluded.new_fat, username = excluded.username;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.log_saved_meal(bigint) from public, anon;
grant execute on function public.log_saved_meal(bigint) to authenticated;

-- Editing a saved item's name/macros, or deleting it (incl. via meal delete cascade), retires its verified row.
create or replace function public.saved_item_retire_fb() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' or (new.name, new.protein, new.carbs, new.fat, new.calories)
       is distinct from (old.name, old.protein, old.carbs, old.fat, old.calories) then
    update estimation_feedback set active = false where saved_meal_item_id = old.id and active;
  end if;
  return coalesce(new, old);
end $$;
drop trigger if exists trg_saved_item_retire_fb on public.saved_meal_items;
create trigger trg_saved_item_retire_fb before update or delete on public.saved_meal_items
  for each row execute function public.saved_item_retire_fb();

-- match_feedback: also returns source/confidence; high confidence x1.5 score. Threshold/window/decay unchanged.
drop function if exists public.match_feedback(text, int);
create or replace function public.match_feedback(p_name text, p_limit int default 3)
returns table(username text, food_name text, orig_protein numeric, orig_carbs numeric, orig_fat numeric, orig_calories numeric,
              new_protein numeric, new_carbs numeric, new_fat numeric, new_calories numeric,
              sim real, age_days int, score real, source text, confidence text)
language sql stable security definer set search_path = public, extensions as $$
  select f.username, f.food_name, f.orig_protein, f.orig_carbs, f.orig_fat, f.orig_calories,
         f.new_protein, f.new_carbs, f.new_fat, f.new_calories,
         similarity(f.food_key, norm_food(p_name)) as sim,
         extract(day from now() - f.created_at)::int as age_days,
         (similarity(f.food_key, norm_food(p_name)) * exp(-extract(epoch from now() - f.created_at) / 86400 / 60.0)
           * case when f.confidence = 'high' then 1.5 else 1 end)::real as score,
         f.source, f.confidence
  from public.estimation_feedback f
  where f.active and f.created_at > now() - interval '180 days'
    and f.food_key % norm_food(p_name)
  order by score desc
  limit least(greatest(coalesce(p_limit, 3), 1), 10)
$$;
revoke all on function public.match_feedback(text, int) from public, anon;
grant execute on function public.match_feedback(text, int) to authenticated, service_role;
