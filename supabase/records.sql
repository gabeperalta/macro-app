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
