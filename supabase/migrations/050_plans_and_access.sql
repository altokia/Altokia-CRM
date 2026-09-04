-- ============================================================
-- 050 — Plans, and Altokia holding the keys
-- ============================================================
-- Two things the console could not do, and a business that sells seats
-- needs both.
--
-- 1. PLANS WERE FREE TEXT. `accounts.plan` (045) accepted any string, so
--    "Premium", "premium" and "premiun" were three different plans, and
--    nothing anywhere could say what a plan actually includes. A tier
--    has to be a row with limits attached, or "move them to intermediate"
--    means nothing to the software.
--
-- 2. THE CLIENT HAD TO SIGN UP BEFORE ALTOKIA COULD SELL TO THEM. The
--    provisioning flow could only claim a workspace that a signup had
--    already created, because accounts.owner_user_id is NOT NULL with a
--    unique index (017, a locked design decision). That is backwards for
--    a business that sells a service and hands over the keys: the
--    operator should create the login, set the password, and give the
--    client credentials that already work.
--
--    That needs no schema change. Creating the auth user from the admin
--    API fires the same handle_new_user trigger (017), and the account
--    appears exactly as it would have from a self-signup. What was
--    missing is the record of Altokia holding those keys, which is what
--    the columns below track.
--
-- Revoking access is deliberately separate from suspending an account.
-- Suspension is commercial and leaves the customer able to read their
-- own data. Revoking access means "these people cannot sign in", and it
-- is enforced on the auth user itself; the column here is the readable
-- half, so the console and the audit log can show it without reaching
-- into the auth schema.
--
-- Idempotent: safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. The plan catalogue
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_plans (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  -- What the tier includes. An absent key means no ceiling, so a plan
  -- can grow a limit later without a migration and without retroactively
  -- capping the accounts that never had one.
  limits      JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Informational only: the console displays it, nothing charges on it.
  price_note  TEXT,
  position    INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT platform_plans_limits_is_object CHECK (jsonb_typeof(limits) = 'object'),
  CONSTRAINT platform_plans_code_format CHECK (code ~ '^[a-z][a-z0-9_]{0,31}$')
);

ALTER TABLE platform_plans ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at_platform_plans ON platform_plans;
CREATE TRIGGER set_updated_at_platform_plans
  BEFORE UPDATE ON platform_plans
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Any signed-in user may read the catalogue: a customer is entitled to
-- see what their own tier includes. Only Altokia changes it.
DROP POLICY IF EXISTS platform_plans_select ON platform_plans;
CREATE POLICY platform_plans_select ON platform_plans FOR SELECT
  USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS platform_plans_write ON platform_plans;
CREATE POLICY platform_plans_write ON platform_plans FOR ALL
  USING (is_platform_operator('billing'))
  WITH CHECK (is_platform_operator('billing'));

-- Seeded rather than hard-coded: a starting price list whose every field
-- the console can edit. ON CONFLICT DO NOTHING so a re-run never
-- overwrites a limit somebody tuned.
INSERT INTO platform_plans (code, name, description, limits, position)
VALUES
  ('basico', 'Básico',
   'Un número de WhatsApp y un equipo pequeño. Para empezar.',
   '{"seats": 3, "contacts": 2000, "ai_replies_per_month": 1000, "knowledge_documents": 20, "catalog_items": 50}'::jsonb,
   1),
  ('intermedio', 'Intermedio',
   'Varios asesores por turnos, catálogo completo y asistente sin límite práctico.',
   '{"seats": 10, "contacts": 10000, "ai_replies_per_month": 5000, "knowledge_documents": 100, "catalog_items": 500}'::jsonb,
   2),
  ('premium', 'Premium',
   'Equipos grandes, volumen alto y soporte prioritario.',
   '{"seats": 50, "contacts": 100000, "ai_replies_per_month": 25000, "knowledge_documents": 1000, "catalog_items": 5000}'::jsonb,
   3)
ON CONFLICT (code) DO NOTHING;

-- ------------------------------------------------------------
-- 2. accounts.plan becomes a real reference
-- ------------------------------------------------------------
-- Anything already stored that is not a known code was free text and
-- meant nothing; null is the honest value for it.
UPDATE accounts
   SET plan = NULL
 WHERE plan IS NOT NULL
   AND plan NOT IN (SELECT code FROM platform_plans);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_plan_fkey') THEN
    ALTER TABLE accounts
      ADD CONSTRAINT accounts_plan_fkey
      FOREIGN KEY (plan) REFERENCES platform_plans(code) ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_accounts_plan ON accounts(plan);

-- ------------------------------------------------------------
-- 3. Altokia holds the keys, and it shows
-- ------------------------------------------------------------
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS access_revoked_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS access_revoked_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS access_revoked_reason TEXT,
  -- Set when an operator created the login instead of the customer
  -- signing up. Tells the console whether resetting a password is
  -- routine or a surprise for the customer.
  ADD COLUMN IF NOT EXISTS credentials_issued_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS credentials_issued_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_accounts_access_revoked
  ON accounts(access_revoked_at)
  WHERE access_revoked_at IS NOT NULL;

COMMENT ON COLUMN accounts.access_revoked_at IS
  'Set when Altokia blocked this client from signing in. Enforcement is the ban on the auth users themselves; this column is the readable half. Separate from status: a suspended account can still read its own data, a revoked one cannot get in at all.';

-- ------------------------------------------------------------
-- 4. The guard from 046 covers the new columns too
-- ------------------------------------------------------------
-- Without this a client admin could clear their own revocation, and the
-- whole feature would be decorative.
CREATE OR REPLACE FUNCTION public.guard_account_platform_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF current_user IN ('service_role', 'postgres', 'supabase_admin', 'supabase_auth_admin') THEN
    RETURN NEW;
  END IF;

  IF NEW.status                IS DISTINCT FROM OLD.status
  OR NEW.plan                  IS DISTINCT FROM OLD.plan
  OR NEW.limits                IS DISTINCT FROM OLD.limits
  OR NEW.trial_ends_at         IS DISTINCT FROM OLD.trial_ends_at
  OR NEW.suspended_at          IS DISTINCT FROM OLD.suspended_at
  OR NEW.suspended_reason      IS DISTINCT FROM OLD.suspended_reason
  OR NEW.provisioned_by        IS DISTINCT FROM OLD.provisioned_by
  OR NEW.provisioned_at        IS DISTINCT FROM OLD.provisioned_at
  OR NEW.external_ref          IS DISTINCT FROM OLD.external_ref
  OR NEW.access_revoked_at     IS DISTINCT FROM OLD.access_revoked_at
  OR NEW.access_revoked_by     IS DISTINCT FROM OLD.access_revoked_by
  OR NEW.access_revoked_reason IS DISTINCT FROM OLD.access_revoked_reason
  OR NEW.credentials_issued_at IS DISTINCT FROM OLD.credentials_issued_at
  OR NEW.credentials_issued_by IS DISTINCT FROM OLD.credentials_issued_by
  THEN
    IF NOT is_platform_operator('billing') THEN
      RAISE EXCEPTION 'Only Altokia can change the plan, status or access of an account'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.guard_account_platform_columns() OWNER TO postgres;
