-- ============================================================
-- 038_contact_opt_out
--
-- WhatsApp Business Policy compliance: a business must stop messaging
-- a customer who asks to stop. Adds the state column enforced by
-- src/lib/whatsapp/opt-out.ts across every proactive send path
-- (broadcasts, automations, flows). Set by the inbound webhook when a
-- customer's message body is exactly an opt-out keyword ("stop",
-- "unsubscribe", ...); cleared on an opt-in keyword ("start", ...).
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS opted_out BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS opted_out_at TIMESTAMPTZ;

COMMENT ON COLUMN contacts.opted_out IS
  'True when the contact has asked to stop receiving messages (e.g. replied STOP). Enforced against broadcasts, automations, and flow sends — see src/lib/whatsapp/opt-out.ts.';

CREATE INDEX IF NOT EXISTS idx_contacts_opted_out
  ON contacts (account_id, opted_out)
  WHERE opted_out;
