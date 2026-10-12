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
