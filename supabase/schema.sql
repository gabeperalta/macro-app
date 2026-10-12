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

-- 12-month data retention (pg_cron, free on Supabase). Safe to re-run.
create extension if not exists pg_cron;
select cron.unschedule(jobid) from cron.job where jobname = 'delete-old-meal-items';
select cron.schedule('delete-old-meal-items', '15 3 * * *',
  $$delete from public.meal_items where eaten_at < now() - interval '12 months'$$);

-- ===== Account approval (same as supabase/approval.sql) =====
-- Account approval + ntfy signup alerts. Safe to re-run (idempotent).
-- Run in Supabase: SQL Editor -> New query -> paste -> Run

create extension if not exists pg_net;

-- Private settings (RLS on, no policies => not readable through the API)
create table if not exists public.app_settings (
  key   text primary key,
  value text
);
alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon, authenticated;

-- One profile per user; approved=false until you tick it in Table Editor
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  username   text,
  approved   boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
revoke insert, update, delete on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
drop policy if exists "own profile select" on public.profiles;
create policy "own profile select" on public.profiles for select to authenticated using (auth.uid() = id);
-- No insert/update/delete policies: users cannot approve themselves.

-- New signup -> profile row + push notification (never blocks the signup)
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  uname text := split_part(new.email, '@macro.local', 1);
  topic text;
begin
  insert into public.profiles (id, username) values (new.id, uname)
  on conflict (id) do nothing;
  begin
    select value into topic from public.app_settings where key = 'ntfy_topic';
    if topic is not null and topic <> '' then
      perform net.http_post(
        url := 'https://ntfy.sh/',
        body := jsonb_build_object(
          'topic', topic,
          'title', 'Macro app signup',
          'message', 'New Macro app signup: ' || uname || ' – approve in Supabase Table Editor > profiles'),
        headers := '{"Content-Type": "application/json"}'::jsonb);
    end if;
  exception when others then
    raise warning 'ntfy notification failed: %', sqlerrm;
  end;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Approve everyone who already exists (creates missing profiles). Re-run any time.
create or replace function public.approve_existing_users()
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  insert into public.profiles (id, username, approved)
  select u.id, split_part(u.email, '@macro.local', 1), true from auth.users u
  on conflict (id) do update set approved = true;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.approve_existing_users() from public, anon, authenticated;
select public.approve_existing_users();

-- Meals require an approved profile
drop policy if exists "own rows select" on public.meal_items;
drop policy if exists "own rows insert" on public.meal_items;
drop policy if exists "own rows update" on public.meal_items;
drop policy if exists "own rows delete" on public.meal_items;
create policy "own rows select" on public.meal_items for select to authenticated
  using (auth.uid() = user_id and exists (select 1 from public.profiles where id = auth.uid() and approved));
create policy "own rows insert" on public.meal_items for insert to authenticated
  with check (auth.uid() = user_id and exists (select 1 from public.profiles where id = auth.uid() and approved));
create policy "own rows update" on public.meal_items for update to authenticated
  using (auth.uid() = user_id and exists (select 1 from public.profiles where id = auth.uid() and approved))
  with check (auth.uid() = user_id and exists (select 1 from public.profiles where id = auth.uid() and approved));
create policy "own rows delete" on public.meal_items for delete to authenticated
  using (auth.uid() = user_id and exists (select 1 from public.profiles where id = auth.uid() and approved));

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

-- Calorie goal (same over/under/range rules). Safe to re-run.
alter table public.goals add column if not exists cal_dir text;
alter table public.goals add column if not exists cal_g   numeric check (cal_g >= 0);
alter table public.goals add column if not exists cal_max numeric check (cal_max >= 0);
alter table public.goals drop constraint if exists goals_cal_dir_check;
alter table public.goals add constraint goals_cal_dir_check check (cal_dir in ('over','under','range'));
