-- ============================================================
-- 042_bookings_realtime.sql
--
-- Enables Supabase Realtime (postgres_changes) on `bookings` so the
-- dashboard's booking metrics + upcoming-meetings widgets can update
-- live instead of only on page load — mirrors how `messages` /
-- `conversations` / `notifications` were each added to the
-- `supabase_realtime` publication in their own migrations (001, 027).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'bookings'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE bookings;
  END IF;
END $$;
