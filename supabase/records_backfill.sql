-- ONE-TIME best-effort backfill (already run on the live DB 2026-10-11). There is no goal history, so past
-- logged days are judged against each user's CURRENT goals. Days grouped in America/Los_Angeles (assumption:
-- the existing users are in that timezone). Today is excluded (the app writes today). Skips existing rows.
with days as (
  select m.user_id, (m.eaten_at at time zone 'America/Los_Angeles')::date as day,
         sum(m.protein) p, sum(m.carbs) c, sum(m.fat) f
  from public.meal_items m
  where m.eaten_at >= now() - interval '12 months'
  group by 1, 2
), tot as (
  select d.user_id, d.day, v.item, v.total, v.dir, v.gmin, v.gmax
  from days d join public.goals g on g.user_id = d.user_id
  cross join lateral (values
    ('calories', 4*d.p + 4*d.c + 9*d.f, g.cal_dir, g.cal_g, g.cal_max),
    ('protein',  d.p, g.protein_dir, g.protein_g, g.protein_max),
    ('carbs',    d.c, g.carbs_dir,   g.carbs_g,   g.carbs_max),
    ('fat',      d.f, g.fat_dir,     g.fat_g,     g.fat_max)) v(item, total, dir, gmin, gmax)
  where d.day < (now() at time zone 'America/Los_Angeles')::date
    and v.dir is not null and v.gmin is not null and (v.dir <> 'range' or v.gmax is not null)
)
insert into public.daily_records (user_id, day, item, met, total, goal_dir, goal_min, goal_max)
select user_id, day, item,
       case dir when 'over' then total >= gmin when 'under' then total <= gmin else total between gmin and gmax end,
       round(total, 1), dir, gmin, case when dir = 'range' then gmax end
from tot
on conflict (user_id, day, item) do nothing
returning user_id;
