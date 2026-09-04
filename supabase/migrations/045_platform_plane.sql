-- ============================================================
-- 045 — The platform plane: Altokia as the operator of many tenants
-- ============================================================
-- Everything before this migration describes ONE business using the
-- CRM. Tenancy was already solid (017 gave every table an account_id
-- and RLS through is_account_member), but there was no notion of the
-- company that *sells* the CRM: no operator role, no client status, no
-- way to provision or suspend, and no audit of staff access. The only
-- cross-tenant credential in existence was the service-role key, which
-- bypasses everything and leaves no trace.
--
-- This migration adds that second plane, deliberately *orthogonal* to
-- the tenant one:
--
--   1. platform_operators — who works for Altokia. Separate from
--      profiles, so the "one login, one account" rule (017's locked
--      design decision, idx_accounts_one_per_owner) stays untouched.
--      An operator is not a member of any client account.
--   2. accounts gains its commercial half: status, plan, limits,
--      trial and suspension. Nothing enforces them yet — the column
--      has to exist before any code can read it.
--   3. platform_audit_log — every operator action against a client.
--      Readable by the client too: "who from Altokia looked at my
--      data" is a question a customer is entitled to answer.
--   4. platform_access_grants — consent. An operator does not get to
--      read a client's conversations because they feel like it; the
--      client's admin grants time-boxed access, and it expires.
--   5. whatsapp_config gains per-tenant Meta app credentials and an
--      opaque webhook token. Meta signs each event with the App Secret
--      of the app that receives it, so one global META_APP_SECRET can
--      only ever validate one client. The token gives every tenant its
--      own webhook URL, which is what lets the handler pick the right
--      secret *before* parsing the signed body.
--
-- Deliberately NOT here: enforcement. Suspending an account sets a
-- column; making the send path honour it is application code, and it
-- lands with the routes that read it.
--
-- Idempotent: safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Who works for Altokia
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'platform_role_enum') THEN
    CREATE TYPE platform_role_enum AS ENUM ('support', 'billing', 'owner');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS platform_operators (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role       platform_role_enum NOT NULL DEFAULT 'support',
  full_name  TEXT,
  -- Free-text note for the human reading the list a year from now
  -- ("contractor, offboard in March").
  note       TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE platform_operators ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at_platform_operators ON platform_operators;
CREATE TRIGGER set_updated_at_platform_operators
  BEFORE UPDATE ON platform_operators
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

/**
 * Is the caller staff, at or above `min_role`?
 *
 * SECURITY DEFINER because platform_operators is itself protected by a
 * policy that calls this function — reading it directly under RLS would
 * recurse. Takes no user parameter on purpose: the identity always
 * comes from auth.uid(), so there is nothing a client can forge.
 */
CREATE OR REPLACE FUNCTION public.is_platform_operator(
  min_role platform_role_enum DEFAULT 'support'
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM platform_operators po
     WHERE po.user_id = auth.uid()
       -- The enum is declared in ascending order of power, so its
       -- native ordering is the hierarchy: owner >= billing >= support.
       AND po.role >= min_role
  );
$$;

ALTER FUNCTION public.is_platform_operator(platform_role_enum) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_platform_operator(platform_role_enum) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_platform_operator(platform_role_enum) TO authenticated, service_role;

-- Staff can see the roster. Only a platform owner changes it, and the
-- very first row has to be inserted with the service role — there is no
-- bootstrap path through the API on purpose.
DROP POLICY IF EXISTS platform_operators_select ON platform_operators;
CREATE POLICY platform_operators_select ON platform_operators FOR SELECT
  USING (is_platform_operator());

DROP POLICY IF EXISTS platform_operators_write ON platform_operators;
CREATE POLICY platform_operators_write ON platform_operators FOR ALL
  USING (is_platform_operator('owner'))
  WITH CHECK (is_platform_operator('owner'));

-- ------------------------------------------------------------
-- 2. An account becomes a customer
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'account_status_enum') THEN
    CREATE TYPE account_status_enum AS ENUM ('trial', 'active', 'suspended', 'cancelled');
  END IF;
END $$;

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS status            account_status_enum NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS plan              TEXT,
  -- Per-plan ceilings, read by the application. JSONB rather than a
  -- column per limit because the list will change with the price list,
  -- and a pricing change must not be a migration.
  ADD COLUMN IF NOT EXISTS limits            JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS trial_ends_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suspended_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suspended_reason  TEXT,
  -- Who at Altokia created this client, and the id it carries in
  -- whatever system actually bills it.
  ADD COLUMN IF NOT EXISTS provisioned_by    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS provisioned_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS external_ref      TEXT,
  ADD COLUMN IF NOT EXISTS operator_notes    TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_limits_is_object') THEN
    ALTER TABLE accounts
      ADD CONSTRAINT accounts_limits_is_object CHECK (jsonb_typeof(limits) = 'object');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);

COMMENT ON COLUMN accounts.status IS
  'Lifecycle as seen by Altokia. Only ''active'' and ''trial'' may send; the send paths read this.';
COMMENT ON COLUMN accounts.limits IS
  'Per-plan ceilings, e.g. {"seats": 5, "ai_replies_per_month": 2000}. Absent key = no limit.';

-- ------------------------------------------------------------
-- 3. Every operator action, on the record
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_audit_log (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  operator_user_id  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Null for actions that are not about one client (listing the roster,
  -- say). Never cascades: deleting a client must not erase the record
  -- of what was done to it.
  account_id        UUID REFERENCES accounts(id) ON DELETE SET NULL,
  -- Free text by design: a new operator action is a constant in the
  -- app, not a migration. Same reasoning as tasks.action_type (041).
  action            TEXT NOT NULL,
  detail            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT platform_audit_detail_is_object CHECK (jsonb_typeof(detail) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_platform_audit_account ON platform_audit_log(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_audit_operator ON platform_audit_log(operator_user_id, created_at DESC);

ALTER TABLE platform_audit_log ENABLE ROW LEVEL SECURITY;

-- Staff read everything. A client reads what was done to *them* — the
-- transparency half of "support access with consent". Nobody writes
-- through RLS: entries come from the service role inside the platform
-- routes, so an operator cannot forge or delete their own trail.
DROP POLICY IF EXISTS platform_audit_select_operator ON platform_audit_log;
CREATE POLICY platform_audit_select_operator ON platform_audit_log FOR SELECT
  USING (is_platform_operator());

DROP POLICY IF EXISTS platform_audit_select_account ON platform_audit_log;
CREATE POLICY platform_audit_select_account ON platform_audit_log FOR SELECT
  USING (account_id IS NOT NULL AND is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------
-- 4. Consent for support access
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'access_grant_status_enum') THEN
    CREATE TYPE access_grant_status_enum AS ENUM ('pending', 'granted', 'revoked', 'expired');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS platform_access_grants (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  operator_user_id  UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status            access_grant_status_enum NOT NULL DEFAULT 'pending',
  -- Why the operator needs to look. Shown to the client verbatim, so
  -- "debugging" is a bad reason and the UI should say so.
  reason            TEXT NOT NULL,
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  granted_at        TIMESTAMPTZ,
  granted_by        UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  revoked_at        TIMESTAMPTZ,
  -- Access is always time-boxed. An open-ended grant is how "support
  -- looked once in March" becomes "support can read everything".
  expires_at        TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_access_grants_account ON platform_access_grants(account_id, status);
CREATE INDEX IF NOT EXISTS idx_access_grants_operator ON platform_access_grants(operator_user_id, status);
-- One live request per operator per client: asking twice must not
-- create two rows the client has to answer separately.
CREATE UNIQUE INDEX IF NOT EXISTS idx_access_grants_one_open
  ON platform_access_grants(account_id, operator_user_id)
  WHERE status IN ('pending', 'granted');

ALTER TABLE platform_access_grants ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at_access_grants ON platform_access_grants;
CREATE TRIGGER set_updated_at_access_grants
  BEFORE UPDATE ON platform_access_grants
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP POLICY IF EXISTS access_grants_select ON platform_access_grants;
CREATE POLICY access_grants_select ON platform_access_grants FOR SELECT
  USING (is_platform_operator() OR is_account_member(account_id, 'admin'));

-- The client's admin is the only one who can move a request to granted
-- or revoked. An operator creating their own grant would make the whole
-- mechanism theatre, so inserts come from the service role only.
DROP POLICY IF EXISTS access_grants_update ON platform_access_grants;
CREATE POLICY access_grants_update ON platform_access_grants FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

/**
 * Does this operator currently hold consent for this account?
 *
 * The single definition of "may look", used by the platform routes
 * before they read anything belonging to a client. Expiry is evaluated
 * here rather than by a sweeper job, so a grant that ran out is
 * inactive the moment it runs out.
 */
CREATE OR REPLACE FUNCTION public.has_platform_access(p_account_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM platform_access_grants g
     WHERE g.account_id = p_account_id
       AND g.operator_user_id = auth.uid()
       AND g.status = 'granted'
       AND g.expires_at > NOW()
  );
$$;

ALTER FUNCTION public.has_platform_access(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.has_platform_access(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_platform_access(UUID) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 5. Per-tenant Meta credentials and webhook address
-- ------------------------------------------------------------
-- Meta signs each webhook delivery with the App Secret of the app that
-- receives it. With one Meta app per client there are N secrets, and a
-- single global META_APP_SECRET can validate exactly one of them — the
-- other N-1 clients would get 401 on every inbound message. The fix is
-- an address per tenant: the opaque token below becomes the last
-- segment of that client's webhook URL, so the handler can resolve the
-- account and its secret *before* it verifies the signature over the
-- raw body.
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS app_id        TEXT,
  -- Encrypted with the same envelope as access_token (lib/whatsapp/
  -- encryption.ts). Null means "fall back to the deployment-wide
  -- META_APP_SECRET", which is what the existing single tenant uses.
  ADD COLUMN IF NOT EXISTS app_secret    TEXT,
  ADD COLUMN IF NOT EXISTS webhook_token TEXT;

-- 32 hex chars from two v4 UUIDs: unguessable, and it avoids depending
-- on pgcrypto being enabled.
UPDATE whatsapp_config
   SET webhook_token = replace(uuid_generate_v4()::text, '-', '')
 WHERE webhook_token IS NULL;

ALTER TABLE whatsapp_config
  ALTER COLUMN webhook_token SET DEFAULT replace(uuid_generate_v4()::text, '-', '');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'idx_whatsapp_config_webhook_token'
  ) THEN
    CREATE UNIQUE INDEX idx_whatsapp_config_webhook_token
      ON whatsapp_config(webhook_token);
  END IF;
END $$;

COMMENT ON COLUMN whatsapp_config.webhook_token IS
  'Opaque last segment of this tenant''s webhook URL. Lets the handler pick the right app secret before verifying the signature.';
COMMENT ON COLUMN whatsapp_config.app_secret IS
  'Encrypted per-tenant Meta App Secret. Null falls back to META_APP_SECRET for the original single-tenant deployment.';
