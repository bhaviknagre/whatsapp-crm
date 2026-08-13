-- ============================================================
-- 044_saas_platform.sql — Multi-tenant SaaS conversion: account
-- status + super admin platform panel.
--
-- "organizations" in the product sense IS the existing `accounts`
-- table from 017_account_sharing.sql — this migration extends it
-- rather than introducing a parallel tenancy system:
--   1. accounts.status ('active'|'suspended'|'cancelled')
--   2. profiles.is_super_admin — a platform-operator flag, orthogonal
--      to account_role (a super admin still has a normal account of
--      their own; this is an additional capability, not a role tier)
--   3. is_account_member() gains a status='active' requirement. Every
--      existing RLS policy across ~30 tables calls this ONE function
--      by name — none of those policies change; they all inherit the
--      suspension gate automatically.
--   4. is_account_member_raw() — the original (pre-gate) logic,
--      membership + role only. accounts' OWN select/update policies
--      move to this, because a suspended tenant's members must still
--      be able to read their own accounts row (that's how the app
--      knows to show the "you're suspended" page) — gating that read
--      on itself would be a self-locking chicken-and-egg bug.
--   5. Column-level guard triggers on accounts.status and
--      profiles.is_super_admin. RLS restricts which ROWS an UPDATE
--      may touch, not which COLUMNS — without this, any tenant admin
--      could UPDATE their own accounts row to flip status back to
--      'active', or any user could UPDATE their own profile to set
--      is_super_admin=true. Same bug shape, same fix pattern, as
--      034_fix_profiles_update_rls.sql (GHSA-fg5p-2qc3-jmxr): reject
--      the column change when current_user = 'authenticated' (the
--      browser/PostgREST client); service-role (super-admin API
--      routes) and SECURITY DEFINER functions (owned by postgres)
--      pass through untouched.
--   6. super_admin_audit_log — append-only trail for suspend/
--      reactivate/cancel/create actions, service-role only, same
--      convention as booking_events/automation_logs/flow_run_events.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ------------------------------------------------------------
-- 1. accounts.status
-- ------------------------------------------------------------
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'cancelled'));

CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);

COMMENT ON COLUMN accounts.status IS
  'active|suspended|cancelled. Gated into is_account_member() (not a per-table policy change) — suspending an account denies read/write on every tenant-scoped table automatically. Column-level UPDATE protection: see enforce_accounts_privilege_columns trigger below.';

-- ------------------------------------------------------------
-- 2. profiles.is_super_admin
-- ------------------------------------------------------------
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_profiles_super_admin
  ON profiles(user_id) WHERE is_super_admin = true;

COMMENT ON COLUMN profiles.is_super_admin IS
  'Platform-operator flag, orthogonal to account_role. Bootstrap the first super admin manually: UPDATE profiles SET is_super_admin = true WHERE email = ''<you>''. Column-level UPDATE protection: see enforce_profile_privilege_columns trigger below.';

-- ------------------------------------------------------------
-- 3 & 4. is_account_member_raw (unchanged original logic) +
-- is_account_member (adds the status='active' requirement).
--
-- SECURITY DEFINER, owned by postgres, so this JOIN to accounts is
-- not subject to RLS recursion (no migration sets FORCE ROW LEVEL
-- SECURITY anywhere in this schema — confirmed).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION is_account_member_raw(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM profiles p
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
      AND CASE p.account_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
        >=
          CASE min_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
  );
$$;

ALTER FUNCTION is_account_member_raw(UUID, account_role_enum) OWNER TO postgres;

CREATE OR REPLACE FUNCTION is_account_member(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT is_account_member_raw(target_account_id, min_role)
    AND EXISTS (
      SELECT 1 FROM accounts a
      WHERE a.id = target_account_id AND a.status = 'active'
    );
$$;

ALTER FUNCTION is_account_member(UUID, account_role_enum) OWNER TO postgres;

-- accounts' own SELECT/UPDATE policies move to the raw (non-status-
-- gated) check — every other table's policies are untouched and
-- automatically inherit the new gate via is_account_member() above.
DROP POLICY IF EXISTS accounts_select ON accounts;
DROP POLICY IF EXISTS accounts_update ON accounts;
CREATE POLICY accounts_select ON accounts FOR SELECT
  USING (is_account_member_raw(id));
CREATE POLICY accounts_update ON accounts FOR UPDATE
  USING (is_account_member_raw(id, 'admin'))
  WITH CHECK (is_account_member_raw(id, 'admin'));

-- ------------------------------------------------------------
-- 5a. Column-level guard on accounts.status.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_accounts_privilege_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND current_user = 'authenticated'
  THEN
    RAISE EXCEPTION
      'account status cannot be changed directly; contact support'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_accounts_privilege_columns() OWNER TO postgres;

DROP TRIGGER IF EXISTS enforce_accounts_privilege_columns ON public.accounts;
CREATE TRIGGER enforce_accounts_privilege_columns
  BEFORE UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_accounts_privilege_columns();

-- ------------------------------------------------------------
-- 5b. Extend the EXISTING profiles guard (034) to also cover
-- is_super_admin — same self-escalation risk account_role/account_id
-- had: without this, `UPDATE profiles SET is_super_admin = true
-- WHERE user_id = auth.uid()` would pass RLS (auth.uid() = user_id
-- is unchanged) and fully compromise tenant isolation platform-wide,
-- not just one account. The trigger itself already exists on
-- profiles from 034 — CREATE OR REPLACE on the function is enough,
-- no new trigger needed.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_profile_privilege_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.account_role IS DISTINCT FROM OLD.account_role
      OR NEW.account_id IS DISTINCT FROM OLD.account_id
      OR NEW.is_super_admin IS DISTINCT FROM OLD.is_super_admin)
     AND current_user = 'authenticated'
  THEN
    RAISE EXCEPTION
      'account_role, account_id, and is_super_admin cannot be changed directly; use the account member/invitation RPCs or the super-admin panel'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- ------------------------------------------------------------
-- 6. super_admin_audit_log — append-only, service-role only.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS super_admin_audit_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  target_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  action            TEXT NOT NULL CHECK (action IN ('created', 'suspended', 'reactivated', 'cancelled')),
  metadata          JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_super_admin_audit_log_account
  ON super_admin_audit_log(target_account_id, created_at DESC);

ALTER TABLE super_admin_audit_log ENABLE ROW LEVEL SECURITY;
-- No SELECT/INSERT/UPDATE/DELETE policy for authenticated users — all
-- access is server-side via the service-role key (super-admin API
-- routes), same as automation_pending_executions / booking_reminders.

-- ------------------------------------------------------------
-- Manual validation (run against a live instance — no automated SQL
-- test harness exists in this repo, same caveat as 034):
--
--   1. As a normal (non-super-admin) member JWT via PostgREST:
--        PATCH /rest/v1/accounts?id=eq.<self> {"status":"active"}
--      must fail with 42501 (insufficient_privilege).
--   2. As the same JWT:
--        PATCH /rest/v1/profiles?user_id=eq.<self> {"is_super_admin":true}
--      must fail with 42501.
--   3. Suspend a test account via the service-role super-admin route.
--      Its members must get zero rows from contacts/conversations/
--      messages/deals/etc., but must still be able to SELECT their
--      own accounts row (sees status: 'suspended').
--   4. Reactivate — normal access must return immediately (STABLE,
--      not IMMUTABLE, so no stale-cache concern).
--   5. An existing active account's normal usage (inbox, pipelines,
--      automations, bookings) must be completely unaffected.
-- ------------------------------------------------------------
