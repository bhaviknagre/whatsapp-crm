-- ============================================================
-- 039_bookings.sql — Booking & Meeting Lifecycle Management
--
-- Adds:
--   1. profiles.timezone / profiles.notification_phone — teammate-
--      local message formatting + a WhatsApp number to notify them on.
--   2. calendar_integrations — per-account calendar webhook
--      credentials (Cal.com now; Google Calendar columns scaffolded
--      for a later phase, unused until that ships).
--   3. bookings — one row per calendar booking, upserted idempotently
--      on (calendar_provider, external_booking_id) so reschedule/
--      cancel webhooks update rather than duplicate.
--   4. booking_reminders — scheduled-jobs queue. Mirrors
--      automation_pending_executions' claim-lock pattern (run_at +
--      partial index, status state machine, conditional-UPDATE claim)
--      rather than reusing that table directly — it's schema-coupled
--      to the automation-step engine (next_step_position/parent_step_id)
--      which doesn't fit a booking's lifecycle.
--   5. booking_events — append-only audit trail backing the dashboard
--      analytics widget (confirmation rate / no-show rate / recovered
--      meetings need time-bucketed event counts, not just current-
--      state counts on `bookings`).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ------------------------------------------------------------
-- 1. profiles.timezone / profiles.notification_phone
-- ------------------------------------------------------------
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC',
  ADD COLUMN IF NOT EXISTS notification_phone TEXT;

COMMENT ON COLUMN profiles.timezone IS
  'IANA timezone (e.g. "Asia/Kolkata") used to format teammate-facing booking notifications. Editable in Settings → Profile.';
COMMENT ON COLUMN profiles.notification_phone IS
  'E.164 WhatsApp number this teammate receives booking notifications on (confirmation/reminder/cancellation). NULL disables teammate-side WhatsApp notifications.';

-- ------------------------------------------------------------
-- 2. calendar_integrations — per-account provider credentials
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calendar_integrations (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider                    TEXT NOT NULL CHECK (provider IN ('cal_com', 'google_calendar')),
  -- Opaque, unguessable token embedded in the inbound webhook URL path
  -- so a shared route can resolve "which account is this?" before any
  -- payload parsing happens — Cal.com/Google can't be told to send a
  -- custom CRM header, so the account has to be identified by the URL.
  webhook_token               TEXT NOT NULL,
  -- Cal.com webhook signing secret ("Secret" field in Cal.com's
  -- webhook config), used to verify Cal-Signature-256. AES-256-GCM
  -- encrypted at rest via src/lib/whatsapp/encryption.ts (same
  -- helper webhook_endpoints.secret and whatsapp_config.access_token
  -- already use — generic despite the module name).
  webhook_secret               TEXT,
  -- Google Calendar OAuth (scaffolded only; unused until that phase
  -- ships — see docs/architecture notes for why this is deferred).
  oauth_refresh_token          TEXT,
  google_calendar_id           TEXT,
  google_channel_id            TEXT,
  google_resource_id           TEXT,
  google_channel_expiration    TIMESTAMPTZ,
  -- Plain URL to the account's booking page, embedded in no-show
  -- follow-up messages. MVP: static URL, no live provider API call.
  default_reschedule_url       TEXT,
  is_active                    BOOLEAN NOT NULL DEFAULT true,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(account_id, provider)
);

CREATE UNIQUE INDEX IF NOT EXISTS calendar_integrations_webhook_token_idx
  ON calendar_integrations (webhook_token);

ALTER TABLE calendar_integrations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS calendar_integrations_select ON calendar_integrations;
DROP POLICY IF EXISTS calendar_integrations_insert ON calendar_integrations;
DROP POLICY IF EXISTS calendar_integrations_update ON calendar_integrations;
DROP POLICY IF EXISTS calendar_integrations_delete ON calendar_integrations;
CREATE POLICY calendar_integrations_select ON calendar_integrations FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY calendar_integrations_insert ON calendar_integrations FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY calendar_integrations_update ON calendar_integrations FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
CREATE POLICY calendar_integrations_delete ON calendar_integrations FOR DELETE
  USING (is_account_member(account_id, 'admin'));
-- The inbound calendar webhook route itself resolves the account by
-- webhook_token via the service-role client (no auth.uid() on an
-- unauthenticated inbound request) — RLS above only guards the
-- dashboard settings UI.

DROP TRIGGER IF EXISTS set_updated_at ON calendar_integrations;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON calendar_integrations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- 3. bookings
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bookings (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id                  UUID REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id              UUID REFERENCES conversations(id) ON DELETE SET NULL,
  -- Teammate the meeting is assigned to. References profiles.id (not
  -- auth.users.id) because sends need profiles.timezone /
  -- notification_phone at send time.
  assigned_profile_id          UUID REFERENCES profiles(id) ON DELETE SET NULL,

  calendar_provider            TEXT NOT NULL CHECK (calendar_provider IN ('cal_com', 'google_calendar')),
  -- Cal.com: payload.uid. Google (future): event.id. Unique per
  -- provider so a reschedule/cancel webhook UPSERTs the same row
  -- instead of creating a duplicate.
  external_booking_id          TEXT NOT NULL,

  event_type                   TEXT,   -- Cal.com eventType.slug
  title                         TEXT,   -- agenda / meeting title
  description                   TEXT,

  lead_name                    TEXT,
  lead_phone                   TEXT,   -- E.164; NULL means the booking
                                        -- arrived without a phone question
                                        -- answer and is excluded from the
                                        -- WhatsApp lifecycle (see status
                                        -- below / booking_events 'created'
                                        -- entry logged with metadata
                                        -- noting the skip).
  lead_email                   TEXT,
  lead_timezone                TEXT NOT NULL DEFAULT 'UTC',

  meeting_start_at             TIMESTAMPTZ NOT NULL,
  meeting_end_at                TIMESTAMPTZ NOT NULL,

  reschedule_url                TEXT,

  status TEXT NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('confirmed', 'rescheduled', 'cancelled')),

  -- Set when the lead taps "Got It" on the confirmation or a reminder.
  acknowledged_at               TIMESTAMPTZ,

  -- Manual override + system-detected outcome, separate from `status`
  -- (status tracks the calendar's view of the booking; attendance_status
  -- tracks what actually happened at meeting time).
  attendance_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (attendance_status IN ('pending', 'attended', 'no_show', 'rescheduled')),
  attendance_set_by             UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  attendance_set_at             TIMESTAMPTZ,

  -- True once a booking that was marked no_show gets a *new* bookings
  -- row (via reschedule webhook) — backs the "Recovered Meetings"
  -- dashboard metric.
  recovered                     BOOLEAN NOT NULL DEFAULT false,
  recovered_booking_id          UUID REFERENCES bookings(id) ON DELETE SET NULL,

  -- Superseded-by chain for reschedules.
  rescheduled_to_booking_id     UUID REFERENCES bookings(id) ON DELETE SET NULL,

  raw_payload                   JSONB,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS bookings_external_id_idx
  ON bookings (calendar_provider, external_booking_id);
CREATE INDEX IF NOT EXISTS bookings_account_id_idx ON bookings (account_id);
CREATE INDEX IF NOT EXISTS bookings_conversation_id_idx ON bookings (conversation_id);
CREATE INDEX IF NOT EXISTS bookings_contact_id_idx ON bookings (contact_id);
-- Hot path for the cron's no-show sweep: confirmed bookings whose
-- meeting has ended but attendance hasn't been resolved yet.
CREATE INDEX IF NOT EXISTS bookings_no_show_scan_idx
  ON bookings (account_id, meeting_end_at)
  WHERE status = 'confirmed' AND attendance_status = 'pending';

ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bookings_select ON bookings;
DROP POLICY IF EXISTS bookings_insert ON bookings;
DROP POLICY IF EXISTS bookings_update ON bookings;
CREATE POLICY bookings_select ON bookings FOR SELECT USING (is_account_member(account_id));
CREATE POLICY bookings_insert ON bookings FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY bookings_update ON bookings FOR UPDATE USING (is_account_member(account_id, 'agent'));
-- No DELETE policy — bookings are never hard-deleted from the UI;
-- cancellation is a status transition. Webhook ingestion + cron use
-- the service-role client and bypass RLS entirely (manual account_id
-- scoping in application code).

DROP TRIGGER IF EXISTS set_updated_at ON bookings;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- 4. booking_reminders — scheduled-jobs queue
--
-- Mirrors automation_pending_executions' claim-lock pattern: the cron
-- route drains rows where run_at <= now() AND status = 'pending',
-- claims one at a time via a conditional UPDATE (optimistic lock so
-- overlapping cron invocations don't double-send), and processes it.
-- Service-role only — no user-facing policy, same as
-- automation_pending_executions.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS booking_reminders (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  booking_id   UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'confirmation',
    'cancellation',
    'reminder_1h',
    'reminder_15m',
    'no_show_check',
    'no_show_followup_1m',
    'no_show_followup_4h'
  )),
  run_at       TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'done', 'cancelled', 'failed')),
  -- Missed reminders are a real business cost, unlike an internal
  -- automation step — retry a few times before giving up loudly.
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One row per (booking, kind) — a reschedule upserts run_at rather
  -- than accumulating duplicate reminder rows.
  UNIQUE(booking_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_booking_reminders_due
  ON booking_reminders (run_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_booking_reminders_booking_id
  ON booking_reminders (booking_id);

ALTER TABLE booking_reminders ENABLE ROW LEVEL SECURITY;
-- No SELECT/INSERT/UPDATE/DELETE policy for authenticated users — all
-- access is server-side via the service-role key (webhook + cron).

DROP TRIGGER IF EXISTS set_updated_at ON booking_reminders;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON booking_reminders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- 5. booking_events — append-only audit trail for analytics
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS booking_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  booking_id  UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL CHECK (event_type IN (
    'created', 'rescheduled', 'cancelled',
    'confirmation_sent', 'cancellation_sent',
    'reminder_1h_sent', 'reminder_15m_sent',
    'acknowledged',
    'no_show_followup_1m_sent', 'no_show_followup_4h_sent',
    'attendance_set'
  )),
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_booking_events_account_created
  ON booking_events (account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_booking_events_booking_id
  ON booking_events (booking_id);

ALTER TABLE booking_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS booking_events_select ON booking_events;
CREATE POLICY booking_events_select ON booking_events
  FOR SELECT USING (is_account_member(account_id));
-- INSERT is service-role only (engine/cron); no user-facing write policy.
