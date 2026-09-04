-- ============================================================
-- 048 — Two holes that only matter once there is a second tenant
-- ============================================================
-- 1. FIVE SECURITY DEFINER FUNCTIONS WERE CALLABLE BY ANYONE.
--
-- Postgres grants EXECUTE on a new public-schema function to PUBLIC by
-- default. Most of this repo's SECURITY DEFINER functions revoke it
-- (018, 019, 022, 025, 030, 036, 037, 038, 041, 044); these five never
-- did, and each takes the id of the row it acts on as a parameter. With
-- one tenant that was harmless — the caller and the owner were the same
-- person. With many, any authenticated user of any client could:
--
--   * record_webhook_failure(id, 1)  — disable another client's webhook
--     outright, since max_failures is chosen by the caller.
--   * _bcast_bump(id, col, delta)    — write arbitrary counters on
--     another client's broadcast.
--   * recompute_broadcast_counts(id) — same table, same reach.
--   * claim_ai_reply_slot(conv, n)   — burn another client's auto-reply
--     quota and leave their assistant mute.
--   * seed_default_lead_labels(acct) — insert rows into another
--     client's label set.
--
-- None of them is called from the browser: the two the app invokes go
-- through the service role (lib/ai/auto-reply.ts, lib/webhooks/deliver.ts);
-- the other three run from triggers, which execute as the definer.
-- So the grant can go without touching a line of application code.
--
-- 2. DELETING AN EMPLOYEE'S LOGIN DELETED THE COMPANY'S DATA.
--
-- Seventeen tenant tables carry `user_id ... ON DELETE CASCADE` to
-- auth.users, from before 017 made account_id the tenancy key. The
-- column now means "the agent who created this row" — an audit stamp,
-- not ownership. But the cascade still fires: removing a departing
-- advisor's login took their contacts, conversations (and every message
-- under them), deals, templates, pipelines, automations and flows with
-- it. If that login was the one that connected WhatsApp, the client also
-- stopped receiving messages. Silently, with no error, from a routine
-- admin action.
--
-- These become RESTRICT rather than SET NULL: the columns are NOT NULL,
-- and a refusal is the right answer anyway. Deleting a login that still
-- stamps live company data should require a deliberate decision about
-- that data first, not take it as collateral.
--
-- Idempotent: safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Take back the default grant
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.record_webhook_failure(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_webhook_failure(UUID, INTEGER) TO service_role;

REVOKE ALL ON FUNCTION public.claim_ai_reply_slot(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ai_reply_slot(UUID, INTEGER) TO service_role;

REVOKE ALL ON FUNCTION public.recompute_broadcast_counts(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recompute_broadcast_counts(UUID) TO service_role;

REVOKE ALL ON FUNCTION public.seed_default_lead_labels(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seed_default_lead_labels(UUID) TO service_role;

-- _bcast_bump's signature carries a TEXT column name; revoke by
-- whatever arity is actually present so a rename upstream cannot make
-- this migration fail.
DO $$
DECLARE
  fn RECORD;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = '_bcast_bump'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn.sig);
  END LOOP;
END $$;

-- ------------------------------------------------------------
-- 2. A departing employee no longer takes the data with them
-- ------------------------------------------------------------
DO $$
DECLARE
  t TEXT;
  con TEXT;
  tables TEXT[] := ARRAY[
    'contacts', 'tags', 'custom_fields', 'contact_notes', 'conversations',
    'whatsapp_config', 'message_templates', 'pipelines', 'deals',
    'broadcasts', 'automations', 'automation_logs',
    'automation_pending_executions', 'flows', 'flow_runs', 'quick_replies',
    'advisor_schedules'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    -- Only touch tables that exist and really do cascade today, so a
    -- re-run and a partially-migrated database both behave.
    SELECT c.conname INTO con
      FROM pg_constraint c
      JOIN pg_class rel ON rel.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = rel.relnamespace
     WHERE n.nspname = 'public'
       AND rel.relname = t
       AND c.contype = 'f'
       AND c.confdeltype = 'c'                      -- ON DELETE CASCADE
       AND c.conkey = ARRAY[(
             SELECT a.attnum FROM pg_attribute a
              WHERE a.attrelid = rel.oid AND a.attname = 'user_id'
           )]::smallint[]
     LIMIT 1;

    IF con IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', t, con);
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT',
        t, con
      );
      RAISE NOTICE 'user_id FK on % is now RESTRICT', t;
    END IF;
    con := NULL;
  END LOOP;
END $$;

COMMENT ON COLUMN contacts.user_id IS
  'Agent who created the row. Audit stamp, not tenancy — account_id is the tenancy key (017). RESTRICT since 048: deleting a login must not delete company data.';
