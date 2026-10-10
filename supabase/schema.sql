-- Run in Supabase: SQL Editor -> New query -> paste -> Run
create table if not exists public.meal_items (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  eaten_at    timestamptz not null default now(),
  description text,
  name        text not null,
  protein     numeric(7,1) not null default 0 check (protein >= 0),
  carbs       numeric(7,1) not null default 0 check (carbs >= 0),
  fat         numeric(7,1) not null default 0 check (fat >= 0)
);
create index if not exists meal_items_user_time on public.meal_items (user_id, eaten_at);

alter table public.meal_items enable row level security;

drop policy if exists "own rows select" on public.meal_items;
drop policy if exists "own rows insert" on public.meal_items;
drop policy if exists "own rows update" on public.meal_items;
drop policy if exists "own rows delete" on public.meal_items;
create policy "own rows select" on public.meal_items for select to authenticated using (auth.uid() = user_id);
create policy "own rows insert" on public.meal_items for insert to authenticated with check (auth.uid() = user_id);
create policy "own rows update" on public.meal_items for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows delete" on public.meal_items for delete to authenticated using (auth.uid() = user_id);
