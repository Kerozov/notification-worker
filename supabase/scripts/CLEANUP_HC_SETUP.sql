-- ═══════════════════════════════════════════════════════════════
-- UNDO: accidentally ran healthyandconfident SETUP_DATABASE.sql
-- on the NOTIFICATION-WORKER Supabase project.
--
-- Safe: does NOT drop tenants, email_jobs, sms_jobs, email_deliveries,
-- sms_deliveries, worker_meta, or any worker migration tables.
-- ═══════════════════════════════════════════════════════════════

drop trigger if exists blog_posts_updated_at on public.blog_posts;
drop trigger if exists subscribers_updated_at on public.subscribers;

drop table if exists public.email_campaigns cascade;
drop table if exists public.sms_campaigns cascade;
drop table if exists public.popup_config cascade;
drop table if exists public.segments cascade;
drop table if exists public.subscribers cascade;
drop table if exists public.blog_posts cascade;

drop function if exists public.set_updated_at();

notify pgrst, 'reload schema';

select 'Worker cleanup complete — HC site tables removed' as result;
