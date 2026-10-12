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

-- Locked-in daily goal records. Safe to re-run.
-- The app writes ONLY today's rows (local calendar day sent by the client), judged against the goals in
-- effect at that moment. Once the day ends the app stops updating it, so history is locked in.
create table if not exists public.daily_records (
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  day         date not null,                     -- user's LOCAL calendar date
  item        text not null check (item in ('calories','protein','carbs','fat')),
  met         boolean not null,
  total       numeric,
  goal_dir    text check (goal_dir in ('over','under','range')),
  goal_min    numeric,                           -- value for over/under, min for range
  goal_max    numeric,                           -- range only
  recorded_at timestamptz not null default now(),
  primary key (user_id, day, item)
);
alter table public.daily_records enable row level security;
revoke all on public.daily_records from anon;
grant select, insert, update on public.daily_records to authenticated;
drop policy if exists "own records select" on public.daily_records;
drop policy if exists "own records insert" on public.daily_records;
drop policy if exists "own records update" on public.daily_records;
create policy "own records select" on public.daily_records for select to authenticated
  using (auth.uid() = user_id and exists (select 1 from public.profiles where id = auth.uid() and approved));
create policy "own records insert" on public.daily_records for insert to authenticated
  with check (auth.uid() = user_id and exists (select 1 from public.profiles where id = auth.uid() and approved));
create policy "own records update" on public.daily_records for update to authenticated
  using (auth.uid() = user_id and exists (select 1 from public.profiles where id = auth.uid() and approved))
  with check (auth.uid() = user_id and exists (select 1 from public.profiles where id = auth.uid() and approved));

-- Guard: clients (anon/authenticated roles) may only write rows for day >= current_date - 1
-- (1 day of slack because the client's local date can be behind UTC). A trigger is used rather than a
-- policy so it also covers UPDATEs that try to move a row's day, raises a clear error, and so that
-- admin/maintenance SQL (postgres role: backfills, retention) is not blocked. Also rejects future days.
create or replace function public.daily_records_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('anon', 'authenticated') then
    if new.day < current_date - 1 or new.day > current_date + 1 then
      raise exception 'daily_records: day % is locked (only today can be written)', new.day using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and old.day < current_date - 1 then
      raise exception 'daily_records: day % is locked', old.day using errcode = '42501';
    end if;
    new.recorded_at := now();
  end if;
  return new;
end $$;
drop trigger if exists daily_records_guard on public.daily_records;
create trigger daily_records_guard before insert or update on public.daily_records
  for each row execute function public.daily_records_guard();

-- Today's rows may be removed by the client (goal cleared or all of today's items deleted); past days stay locked.
grant delete on public.daily_records to authenticated;
drop policy if exists "own records delete" on public.daily_records;
create policy "own records delete" on public.daily_records for delete to authenticated
  using (auth.uid() = user_id and exists (select 1 from public.profiles where id = auth.uid() and approved));
create or replace function public.daily_records_delete_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('anon', 'authenticated') and old.day < current_date - 1 then
    raise exception 'daily_records: day % is locked', old.day using errcode = '42501';
  end if;
  return old;
end $$;
drop trigger if exists daily_records_delete_guard on public.daily_records;
create trigger daily_records_delete_guard before delete on public.daily_records
  for each row execute function public.daily_records_delete_guard();

-- Retention: include daily_records in the nightly 12-month cleanup.
create extension if not exists pg_cron;
select cron.unschedule(jobid) from cron.job where jobname = 'delete-old-meal-items';
select cron.schedule('delete-old-meal-items', '15 3 * * *',
  $$delete from public.meal_items where eaten_at < now() - interval '12 months';
    delete from public.daily_records where day < (current_date - interval '12 months')::date$$);

-- Stored calories per item (from the AI / food database). Safe to re-run.
alter table public.meal_items add column if not exists calories numeric check (calories >= 0);
alter table public.meal_items add column if not exists calories_source text;
-- One-time backfill for items saved before calories were stored (old 4p+4c+9f estimate).
update public.meal_items set calories = round(4*protein + 4*carbs + 9*fat, 1), calories_source = 'estimate'
where calories is null;
-- Extra nutrients stored per item (no UI). Existing rows stay null (no backfill).
alter table public.meal_items add column if not exists sodium_mg numeric check (sodium_mg >= 0);
alter table public.meal_items add column if not exists sugar_g   numeric check (sugar_g >= 0);
alter table public.meal_items add column if not exists sat_fat_g numeric check (sat_fat_g >= 0);
