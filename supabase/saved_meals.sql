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
