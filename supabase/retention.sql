-- 12-month data retention (pg_cron, free on Supabase). Safe to re-run.
create extension if not exists pg_cron;
select cron.unschedule(jobid) from cron.job where jobname = 'delete-old-meal-items';
select cron.schedule('delete-old-meal-items', '15 3 * * *',
  $$delete from public.meal_items where eaten_at < now() - interval '12 months'$$);

-- Estimation feedback older than 12 months (added with feedback.sql)
select cron.unschedule(jobid) from cron.job where jobname = 'delete-old-feedback';
select cron.schedule('delete-old-feedback', '20 3 * * *',
  $$delete from public.estimation_feedback where created_at < now() - interval '12 months'$$);
