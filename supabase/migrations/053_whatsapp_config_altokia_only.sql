-- ============================================================
-- 053 — The WhatsApp connection belongs to Altokia
-- ============================================================
-- Connecting a number to the Meta Cloud API is Altokia's job: it needs a
-- Meta app, a permanent token and a webhook address, and the customer is
-- not the one holding any of that. The console does it for them.
--
-- Removing the customer's settings screen and locking the API route was
-- only half of it, and the cheaper half. `whatsapp_config` still carried
-- its 017 policies, which let any admin of the account write and delete
-- the row straight through PostgREST with the anon key the browser
-- already ships. A screen you cannot see is not a permission you do not
-- have. Concretely, before this migration a customer could still:
--
--   * delete their own connection and lose WhatsApp with no explanation,
--   * point their number's config at different credentials,
--   * and read `access_token`, `app_secret`, `verify_token` and
--     `webhook_token` — the last one being the unguessable segment of
--     their webhook URL, which is exactly the secret that lets the
--     per-tenant webhook (047) tell tenants apart.
--
-- So writes move to platform operators, and the secrets stop being
-- selectable at all. Column-level privileges do the second part, because
-- RLS is per row and cannot hide a column.
--
-- What the customer keeps is what a customer needs: whether their number
-- is connected, which number it is, and when it last failed. Enough for
-- the inbox to explain itself, nothing an attacker can use.
--
-- Idempotent: safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Only Altokia writes the connection
-- ------------------------------------------------------------
DROP POLICY IF EXISTS whatsapp_config_insert ON whatsapp_config;
DROP POLICY IF EXISTS whatsapp_config_update ON whatsapp_config;
DROP POLICY IF EXISTS whatsapp_config_delete ON whatsapp_config;

CREATE POLICY whatsapp_config_insert ON whatsapp_config FOR INSERT
  WITH CHECK (is_platform_operator());
CREATE POLICY whatsapp_config_update ON whatsapp_config FOR UPDATE
  USING (is_platform_operator())
  WITH CHECK (is_platform_operator());
CREATE POLICY whatsapp_config_delete ON whatsapp_config FOR DELETE
  USING (is_platform_operator());

-- The service role bypasses RLS, so the platform routes and the webhook
-- keep working exactly as they did. This closes the browser path only.

-- ------------------------------------------------------------
-- 2. The secrets stop being readable
-- ------------------------------------------------------------
-- Row-level security cannot hide a column, so the grant does. Revoking
-- the table-wide SELECT and granting it back column by column means a
-- request for `access_token` is refused outright rather than quietly
-- returning null — the customer's client asks for what it may have.
REVOKE SELECT ON whatsapp_config FROM authenticated;
GRANT SELECT (
  id,
  account_id,
  phone_number_id,
  waba_id,
  status,
  connected_at,
  registered_at,
  subscribed_apps_at,
  last_registration_error,
  mirror_inbound_media,
  created_at,
  updated_at
) ON whatsapp_config TO authenticated;

-- `anon` never had a reason to read this at all.
REVOKE ALL ON whatsapp_config FROM anon;

-- The select policy itself stays as it was: a member may see the row,
-- they just cannot see the four secret columns any more.
COMMENT ON TABLE whatsapp_config IS
  'One WhatsApp connection per account. Written by Altokia only (053); customers may read the non-secret columns so their inbox can explain its own state. access_token, app_secret, verify_token and webhook_token are not selectable by `authenticated` — they reach the browser through nothing.';
