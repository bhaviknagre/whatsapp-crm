-- ============================================================
-- 043_dashboard_realtime.sql
--
-- Enables Supabase Realtime on the remaining tables the dashboard
-- reads from (src/lib/dashboard/queries.ts + booking-queries.ts) so
-- the whole page can update live instead of only on load/tab-focus.
-- `messages` / `conversations` were already enabled (migration 001);
-- `bookings` in 042. This adds the rest: `contacts` (new-contacts
-- metric, activity feed), `deals` (pipeline donut, open-deals value,
-- activity feed), `broadcasts` (activity feed), `automation_logs`
-- (activity feed).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'contacts'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE contacts;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'deals'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE deals;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'broadcasts'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE broadcasts;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'automation_logs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE automation_logs;
  END IF;
END $$;
