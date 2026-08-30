-- CI pipeline test: safe, idempotent, no schema changes
DO $$
BEGIN
  RAISE NOTICE 'notification-worker CI migration test OK at %', now();
END $$;
