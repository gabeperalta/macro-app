-- Shared estimation feedback (see docs/estimation-feedback-spec.md). Safe to re-run.
create extension if not exists pg_trgm with schema extensions;

-- Normalized food name used for matching: lowercase, no punctuation/numbers/quantity words.
create or replace function public.norm_food(t text) returns text
language sql immutable set search_path = public, extensions as $$
  select btrim(regexp_replace(
    regexp_replace(
      regexp_replace(lower(coalesce(t,'')), '[^a-z ]+', ' ', 'g'),
      '\m(x|oz|ounces?|g|grams?|kg|lbs?|pounds?|ml|l|cups?|tbsp|tsp|tablespoons?|teaspoons?|slices?|pieces?|servings?|bowls?|plates?|scoops?|large|medium|small|half|one|two|three|four|a|an|of|the)\M', ' ', 'g'),
    '\s+', ' ', 'g'))
$$;

-- Keep the model's first estimate on every item
alter table public.meal_items
  add column if not exists est_protein numeric, add column if not exists est_carbs numeric,
  add column if not exists est_fat numeric,     add column if not exists est_calories numeric;
-- Metadata backfill only (protein/carbs/fat/calories untouched). Runs before the trigger exists.
update public.meal_items set est_protein=protein, est_carbs=carbs, est_fat=fat, est_calories=calories
 where est_protein is null;

create table if not exists public.estimation_feedback (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references auth.users on delete cascade,
  username      text not null,
  meal_item_id  bigint references public.meal_items on delete set null,
  food_name     text not null,
  food_key      text not null,
  description   text,
  orig_calories numeric, orig_protein numeric, orig_carbs numeric, orig_fat numeric,
  new_calories  numeric, new_protein  numeric, new_carbs  numeric, new_fat  numeric,
  source        text not null default 'manual_edit' check (source in ('manual_edit','correction_pass')),
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);
create index if not exists estimation_feedback_key_trgm on public.estimation_feedback using gin (food_key extensions.gin_trgm_ops);
create index if not exists estimation_feedback_user_active on public.estimation_feedback (user_id, active, created_at desc);
create index if not exists estimation_feedback_item on public.estimation_feedback (meal_item_id) where active;

alter table public.estimation_feedback enable row level security;
drop policy if exists fb_read_all on public.estimation_feedback;
drop policy if exists fb_write_own on public.estimation_feedback;
create policy fb_read_all on public.estimation_feedback for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.approved));
create policy fb_write_own on public.estimation_feedback for insert
  with check (user_id = auth.uid());

-- Trigger: any change to an item's macros/calories writes a feedback row automatically.
create or replace function public.meal_item_feedback() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if (new.protein, new.carbs, new.fat, new.calories) is distinct from
     (old.protein, old.carbs, old.fat, old.calories) then
    update public.estimation_feedback set active = false where meal_item_id = new.id and active;
    insert into public.estimation_feedback(user_id, username, meal_item_id, food_name, food_key, description,
      orig_calories, orig_protein, orig_carbs, orig_fat, new_calories, new_protein, new_carbs, new_fat, source)
    select new.user_id, split_part(u.email, '@', 1), new.id, new.name, public.norm_food(new.name), new.description,
      coalesce(old.est_calories, old.calories), coalesce(old.est_protein, old.protein),
      coalesce(old.est_carbs, old.carbs), coalesce(old.est_fat, old.fat),
      new.calories, new.protein, new.carbs, new.fat,
      coalesce(nullif(current_setting('macro.fb_source', true), ''), 'manual_edit')
    from auth.users u where u.id = new.user_id;
  end if;
  return new;
end $$;
drop trigger if exists trg_meal_feedback on public.meal_items;
create trigger trg_meal_feedback after update on public.meal_items
  for each row execute function public.meal_item_feedback();

-- Shared lookup: all users' active corrections from the last 180 days, recency-decayed (e-fold 60 days).
-- parse-meal keeps only sim >= 0.5.
drop function if exists public.match_feedback(text, int);
create or replace function public.match_feedback(p_name text, p_limit int default 3)
returns table(username text, food_name text, orig_protein numeric, orig_carbs numeric, orig_fat numeric, orig_calories numeric,
              new_protein numeric, new_carbs numeric, new_fat numeric, new_calories numeric,
              sim real, age_days int, score real)
language sql stable security definer set search_path = public, extensions as $$
  select f.username, f.food_name, f.orig_protein, f.orig_carbs, f.orig_fat, f.orig_calories,
         f.new_protein, f.new_carbs, f.new_fat, f.new_calories,
         similarity(f.food_key, norm_food(p_name)) as sim,
         extract(day from now() - f.created_at)::int as age_days,
         (similarity(f.food_key, norm_food(p_name)) * exp(-extract(epoch from now() - f.created_at) / 86400 / 60.0))::real as score
  from public.estimation_feedback f
  where f.active and f.created_at > now() - interval '180 days'
    and f.food_key % norm_food(p_name)
  order by score desc
  limit least(greatest(coalesce(p_limit, 3), 1), 10)
$$;
revoke all on function public.match_feedback(text, int) from public, anon;
grant execute on function public.match_feedback(text, int) to authenticated, service_role;
