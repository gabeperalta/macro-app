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
