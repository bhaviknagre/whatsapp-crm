-- ============================================================
-- 041_meeting_link.sql
--
-- Adds bookings.meeting_link — a video-call URL (Google Meet, Zoom,
-- Teams, etc.) captured either from Cal.com's webhook payload or
-- entered manually when a teammate schedules a meeting from the CRM.
-- When present, it's sent to the lead (and teammate) as its own
-- WhatsApp message right after the confirmation, via a new
-- 'meeting_link' booking_reminders kind — kept separate from the
-- confirmation template so accounts that never set a link don't need
-- an always-populated template variable for it.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS meeting_link TEXT;

COMMENT ON COLUMN bookings.meeting_link IS
  'Video-call URL (Google Meet/Zoom/Teams/etc.), if any. Sent to the lead + teammate as a dedicated WhatsApp message right after the confirmation.';

ALTER TABLE booking_reminders
  DROP CONSTRAINT IF EXISTS booking_reminders_kind_check;

ALTER TABLE booking_reminders
  ADD CONSTRAINT booking_reminders_kind_check
  CHECK (kind IN (
    'confirmation',
    'meeting_link',
    'cancellation',
    'reminder_1h',
    'reminder_15m',
    'no_show_check',
    'no_show_followup_1m',
    'no_show_followup_4h'
  ));

ALTER TABLE booking_events
  DROP CONSTRAINT IF EXISTS booking_events_event_type_check;

ALTER TABLE booking_events
  ADD CONSTRAINT booking_events_event_type_check
  CHECK (event_type IN (
    'created', 'rescheduled', 'cancelled',
    'confirmation_sent', 'meeting_link_sent', 'cancellation_sent',
    'reminder_1h_sent', 'reminder_15m_sent',
    'acknowledged',
    'no_show_followup_1m_sent', 'no_show_followup_4h_sent',
    'attendance_set'
  ));
