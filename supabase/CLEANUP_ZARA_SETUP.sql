-- =====================================================================
-- Пусни САМО в notification-worker проекта в Supabase.
-- НИКОГА в website-zara — там това би изтрило сайта.
--
-- Маха всичко, което website-zara 000_setup_all.sql създава:
-- таблици, функция, storage buckets.
--
-- НЕ пипа worker таблиците:
--   tenants, email_jobs, email_deliveries,
--   sms_jobs, sms_deliveries, worker_meta
--
-- Ако таблицата tenants липсва, скриптът спира (значи не си в worker-а).
-- Ако си пуснал worker setup ВЪРХУ Zara базата, НЕ пускай това тук —
-- tenants/email_jobs ще минат проверката и ще изтрие сайта. Пусни го
-- само в notification-worker проекта.
-- =====================================================================

DO $$
BEGIN
  IF to_regclass('public.tenants') IS NULL
     OR to_regclass('public.email_jobs') IS NULL THEN
    RAISE EXCEPTION
      'Това не изглежда worker база (липсват tenants/email_jobs). Спирам, за да не се изтрие website-zara.';
  END IF;
END $$;

DROP TRIGGER IF EXISTS subscribers_updated_at ON public.subscribers;
DROP TRIGGER IF EXISTS blog_posts_updated_at ON public.blog_posts;

DROP FUNCTION IF EXISTS public.count_unique_site_visitors();
DROP FUNCTION IF EXISTS public.set_updated_at();

DROP TABLE IF EXISTS public.blog_posts CASCADE;
DROP TABLE IF EXISTS public.zoom_attendance CASCADE;
DROP TABLE IF EXISTS public.zoom_meetings CASCADE;
DROP TABLE IF EXISTS public.email_form_responses CASCADE;
DROP TABLE IF EXISTS public.email_forms CASCADE;
DROP TABLE IF EXISTS public.campaign_deliveries CASCADE;
DROP TABLE IF EXISTS public.automation_deliveries CASCADE;
DROP TABLE IF EXISTS public.email_link_clicks CASCADE;
DROP TABLE IF EXISTS public.purchase_events CASCADE;
DROP TABLE IF EXISTS public.site_page_views CASCADE;
DROP TABLE IF EXISTS public.integration_sync_state CASCADE;
DROP TABLE IF EXISTS public.crm_settings CASCADE;
DROP TABLE IF EXISTS public.audience_segments CASCADE;
DROP TABLE IF EXISTS public.site_products CASCADE;
DROP TABLE IF EXISTS public.email_campaigns CASCADE;
DROP TABLE IF EXISTS public.sms_campaigns CASCADE;
DROP TABLE IF EXISTS public.email_footer_config CASCADE;
DROP TABLE IF EXISTS public.automations CASCADE;
DROP TABLE IF EXISTS public.popup_config CASCADE;
DROP TABLE IF EXISTS public.subscribers CASCADE;

-- Storage API (директният DELETE от storage.objects е забранен)
DO $$
DECLARE
  bucket_id text;
BEGIN
  FOREACH bucket_id IN ARRAY ARRAY['product-images', 'automation-attachments']
  LOOP
    BEGIN
      IF EXISTS (SELECT 1 FROM storage.buckets WHERE id = bucket_id) THEN
        PERFORM storage.empty_bucket(bucket_id);
        PERFORM storage.delete_bucket(bucket_id);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Bucket % left in place (%). Delete it from Storage UI if needed.',
        bucket_id, SQLERRM;
    END;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';

SELECT
  'Zara leftovers removed from worker' AS result,
  (
    SELECT string_agg(tablename, ', ' ORDER BY tablename)
    FROM pg_tables
    WHERE schemaname = 'public'
  ) AS remaining_public_tables;
