-- ============================================================
-- 045_pending_registrations.sql — self-signup registration approval.
--
-- Adds two new account.status values:
--   'pending'  — a self-service signup (NOT a super-admin-provisioned
--                client, NOT a teammate accepting an invite into an
--                existing account) awaiting super-admin review. This
--                is now the DEFAULT for new accounts.
--   'rejected' — a pending registration the super admin declined.
--                Soft/terminal, same as 'cancelled': the row stays,
--                access stays blocked, and it's reversible via the
--                same PATCH-status action if reconsidered.
--
-- No new enforcement mechanism needed: is_account_member() (044)
-- already requires status = 'active' exactly, so 'pending' and
-- 'rejected' are denied automatically, identically to 'suspended'.
-- enforce_accounts_privilege_columns (044) already blocks a normal
-- browser client from writing ANY status value, including
-- self-approving out of 'pending'.
--
-- Why this doesn't affect the existing invite/redeem flow: an
-- invited teammate's auto-created personal account (from
-- handle_new_user, now defaulting to 'pending') is DELETED entirely
-- by redeem_invitation() (019_invitation_rpcs.sql) the moment they
-- accept the invite — regardless of that account's status — and
-- redeem_invitation is SECURITY DEFINER (runs as postgres), so it
-- never goes through is_account_member/RLS in the first place. The
-- /join/[token] page also sits outside the (dashboard) route group's
-- AuthProvider, so the pending-redirect never fires mid-redemption.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE accounts
  DROP CONSTRAINT IF EXISTS accounts_status_check;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_status_check
  CHECK (status IN ('pending', 'active', 'suspended', 'cancelled', 'rejected'));

ALTER TABLE accounts
  ALTER COLUMN status SET DEFAULT 'pending';

COMMENT ON COLUMN accounts.status IS
  'pending|active|suspended|cancelled|rejected. New self-signups default to pending (require super-admin approval); super-admin-provisioned clients (POST /api/super-admin/accounts) explicitly set active. Gated into is_account_member() — only "active" grants access to any tenant-scoped table.';

ALTER TABLE super_admin_audit_log
  DROP CONSTRAINT IF EXISTS super_admin_audit_log_action_check;
ALTER TABLE super_admin_audit_log
  ADD CONSTRAINT super_admin_audit_log_action_check
  CHECK (action IN ('created', 'approved', 'suspended', 'reactivated', 'cancelled', 'rejected'));
