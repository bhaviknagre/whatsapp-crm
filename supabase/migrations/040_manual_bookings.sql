-- ============================================================
-- 040_manual_bookings.sql
--
-- The booking lifecycle (039) was built reactive-only: a booking row
-- is created by an inbound Cal.com webhook, never by a teammate
-- directly in the CRM. Adds a 'manual' calendar_provider so an agent
-- can schedule a meeting from the inbox (POST /api/bookings) for
-- teams that don't use Cal.com, or for a meeting arranged over a
-- call/email that never went through a calendar tool.
--
-- Manual bookings get a synthetic external_booking_id
-- ("manual-<uuid>", generated server-side) so the existing
-- UNIQUE(calendar_provider, external_booking_id) index still holds —
-- there's no real external system to key off of.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE bookings
  DROP CONSTRAINT IF EXISTS bookings_calendar_provider_check;

ALTER TABLE bookings
  ADD CONSTRAINT bookings_calendar_provider_check
  CHECK (calendar_provider IN ('cal_com', 'google_calendar', 'manual'));
