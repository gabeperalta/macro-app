-- Per-user macro goals (over/under a gram value). Safe to re-run.
create table if not exists public.goals (
  user_id    uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  protein_dir text check (protein_dir in ('over','under')),
  protein_g   numeric check (protein_g >= 0),
  carbs_dir   text check (carbs_dir in ('over','under')),
  carbs_g     numeric check (carbs_g >= 0),
  fat_dir     text check (fat_dir in ('over','under')),
  fat_g       numeric check (fat_g >= 0),
  updated_at  timestamptz not null default now()
);
alter table public.goals enable row level security;
revoke all on public.goals from anon;
grant select, insert, update, delete on public.goals to authenticated;
drop policy if exists "own goals select" on public.goals;
drop policy if exists "own goals insert" on public.goals;
drop policy if exists "own goals update" on public.goals;
drop policy if exists "own goals delete" on public.goals;
create policy "own goals select" on public.goals for select to authenticated
  using (auth.uid() = user_id and exists (select 1 from public.profiles where id = auth.uid() and approved));
create policy "own goals insert" on public.goals for insert to authenticated
  with check (auth.uid() = user_id and exists (select 1 from public.profiles where id = auth.uid() and approved));
create policy "own goals update" on public.goals for update to authenticated
  using (auth.uid() = user_id and exists (select 1 from public.profiles where id = auth.uid() and approved))
  with check (auth.uid() = user_id and exists (select 1 from public.profiles where id = auth.uid() and approved));
create policy "own goals delete" on public.goals for delete to authenticated
  using (auth.uid() = user_id and exists (select 1 from public.profiles where id = auth.uid() and approved));

-- Range goals (min..max). Safe to re-run; *_g is the value (over/under) or the min (range).
alter table public.goals add column if not exists protein_max numeric check (protein_max >= 0);
alter table public.goals add column if not exists carbs_max   numeric check (carbs_max >= 0);
alter table public.goals add column if not exists fat_max     numeric check (fat_max >= 0);
alter table public.goals drop constraint if exists goals_protein_dir_check;
alter table public.goals drop constraint if exists goals_carbs_dir_check;
alter table public.goals drop constraint if exists goals_fat_dir_check;
alter table public.goals add constraint goals_protein_dir_check check (protein_dir in ('over','under','range'));
alter table public.goals add constraint goals_carbs_dir_check   check (carbs_dir in ('over','under','range'));
alter table public.goals add constraint goals_fat_dir_check     check (fat_dir in ('over','under','range'));
