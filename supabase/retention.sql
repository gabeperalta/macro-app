-- 12-month data retention (pg_cron, free on Supabase). Safe to re-run.
create extension if not exists pg_cron;
select cron.unschedule(jobid) from cron.job where jobname = 'delete-old-meal-items';
select cron.schedule('delete-old-meal-items', '15 3 * * *',
  $$delete from public.meal_items where eaten_at < now() - interval '12 months'$$);
