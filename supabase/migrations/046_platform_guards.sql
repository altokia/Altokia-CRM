-- ============================================================
-- 046 — Guards the platform plane needs to be real
-- ============================================================
-- 045 put the commercial half of a customer (status, plan, limits,
-- suspension, provisioning) on `accounts`. That table's only write
-- policy is 017's `accounts_update USING (is_account_member(id,'admin'))`,
-- and RLS is per ROW, not per column — so every one of those columns was
-- writable by the customer's own admin with nothing but the anon key the
-- browser already ships. A suspended client could PATCH their own row
-- back to active, raise their plan and empty their limits, undoing from
-- the console exactly what the console had just done. That is not a
-- suspension; it is a suggestion.
--
-- This migration:
--   1. Refuses tenant writes to the platform-owned columns, with a
--      trigger rather than column GRANTs so the failure is a readable
--      message instead of a silent no-op.
--   2. Moves operator_notes off `accounts` entirely. `accounts_select`
--      lets any member read the whole row, so an internal note about a
--      customer was readable *by that customer*. No trigger fixes that;
--      the column had to leave.
--   3. Gives each cron job a per-account watermark, so a pass resumes
--      from server state instead of from a cursor the caller has to
--      thread back. The external pinger is one stateless curl; anything
--      that depends on it remembering a cursor never runs for the tail
--      of the customer list.
--   4. Marks the accounts that already exist as provisioned, so the
--      console's "claim this workspace" path cannot target a live
--      customer.
--
-- Idempotent: safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Only Altokia moves the commercial columns
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_account_platform_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Migrations, the service role and the platform routes that run as it
  -- are the intended writers. PostgREST SET ROLEs to the JWT's role, so
  -- current_user is the honest signal here.
  IF current_user IN ('service_role', 'postgres', 'supabase_admin', 'supabase_auth_admin') THEN
    RETURN NEW;
  END IF;

  IF NEW.status           IS DISTINCT FROM OLD.status
  OR NEW.plan             IS DISTINCT FROM OLD.plan
  OR NEW.limits           IS DISTINCT FROM OLD.limits
  OR NEW.trial_ends_at    IS DISTINCT FROM OLD.trial_ends_at
  OR NEW.suspended_at     IS DISTINCT FROM OLD.suspended_at
  OR NEW.suspended_reason IS DISTINCT FROM OLD.suspended_reason
  OR NEW.provisioned_by   IS DISTINCT FROM OLD.provisioned_by
  OR NEW.provisioned_at   IS DISTINCT FROM OLD.provisioned_at
  OR NEW.external_ref     IS DISTINCT FROM OLD.external_ref
  THEN
    -- A platform operator acting through their own session is still
    -- allowed, so the console keeps working if a route ever drops the
    -- service-role client.
    IF NOT is_platform_operator('billing') THEN
      RAISE EXCEPTION
        'Only Altokia can change an account''s plan or status'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.guard_account_platform_columns() OWNER TO postgres;

DROP TRIGGER IF EXISTS guard_account_platform_columns ON accounts;
CREATE TRIGGER guard_account_platform_columns
  BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION guard_account_platform_columns();

-- ------------------------------------------------------------
-- 2. Internal notes leave the tenant's reach
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_account_notes (
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  notes      TEXT NOT NULL DEFAULT '',
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE platform_account_notes ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at_platform_account_notes ON platform_account_notes;
CREATE TRIGGER set_updated_at_platform_account_notes
  BEFORE UPDATE ON platform_account_notes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- No tenant policy at all: the customer is not a reader of this table.
DROP POLICY IF EXISTS platform_account_notes_all ON platform_account_notes;
CREATE POLICY platform_account_notes_all ON platform_account_notes FOR ALL
  USING (is_platform_operator())
  WITH CHECK (is_platform_operator());

-- Carry across anything written while the column still existed.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'accounts' AND column_name = 'operator_notes'
  ) THEN
    INSERT INTO platform_account_notes (account_id, notes)
    SELECT id, operator_notes FROM accounts
     WHERE operator_notes IS NOT NULL AND btrim(operator_notes) <> ''
    ON CONFLICT (account_id) DO NOTHING;

    ALTER TABLE accounts DROP COLUMN operator_notes;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 3. Cron watermarks: the schedule resumes from server state
-- ------------------------------------------------------------
-- Each job stamps the accounts it processed. Ordering by the stamp with
-- NULLS FIRST means "never processed" comes first and the account that
-- has waited longest comes next, so a fixed-size pass sweeps the whole
-- customer list over successive ticks without the caller holding any
-- state. The external pinger stays one stateless curl.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS cron_tasks_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cron_automations_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cron_flows_at       TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_accounts_cron_tasks
  ON accounts(cron_tasks_at NULLS FIRST, id);
CREATE INDEX IF NOT EXISTS idx_accounts_cron_automations
  ON accounts(cron_automations_at NULLS FIRST, id);
CREATE INDEX IF NOT EXISTS idx_accounts_cron_flows
  ON accounts(cron_flows_at NULLS FIRST, id);

COMMENT ON COLUMN accounts.cron_tasks_at IS
  'Last time /api/tasks/cron processed this account. Ordering key for the fair-share sweep; never read by tenant code.';

-- The watermarks are Altokia's bookkeeping, not the tenant's. They are
-- deliberately outside the guard above so a job can stamp them with the
-- service role without tripping it.

-- ------------------------------------------------------------
-- 4. Existing customers are not blank workspaces
-- ------------------------------------------------------------
-- The console can turn an unclaimed workspace into a customer. Every
-- account that exists today predates that flow and is either a live
-- customer or Altokia's own, so none of them is claimable.
UPDATE accounts
   SET provisioned_at = COALESCE(provisioned_at, created_at, NOW())
 WHERE provisioned_at IS NULL;
