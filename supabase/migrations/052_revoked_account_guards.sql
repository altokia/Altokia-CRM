-- ============================================================
-- 052 — A revoked account stays revoked, and an account with data
--       cannot be deleted out from under it
-- ============================================================
-- Two holes, closed with added guards rather than by rewriting the
-- functions involved. That is deliberate: 049 rewrote a whole trigger
-- body to add one condition and silently dropped three behaviours with
-- it. A guard that only ever refuses cannot lose anything.
--
-- 1. AN INVITATION ISSUED BEFORE THE REVOCATION STILL WORKED.
--    050 withdraws access by banning every login on the account.
--    Redeeming an older invitation moves a *different*, freshly-created
--    login into that account — one no ban covers, because it did not
--    exist when the ban was applied. The link may already be in
--    somebody's inbox, and it worked forever. Guarding this in the
--    route would guard nothing: redeem_invitation is SECURITY DEFINER
--    and callable directly, so the check belongs on the write itself.
--
-- 2. REDEEMING DELETED THE JOINER'S PERSONAL ACCOUNT USING AN
--    EMPTINESS CHECK FROZEN IN 019. That list names the tables that
--    existed then. Everything added since — catalog_items, tasks,
--    advisor_profiles, lead_labels, conversation_insights and the rest
--    — was invisible to it, so a workspace full of newer work read as
--    empty and was deleted without a word. The guard below asks the
--    catalogue what tables exist instead of trusting a list, so it
--    cannot go stale again.
--
-- Both refuse with SQLSTATE the routes already map (42501 → 403,
-- 23505 → 409).
--
-- Idempotent: safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Nobody joins an account whose access was withdrawn
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_join_revoked_account()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_revoked TIMESTAMPTZ;
BEGIN
  IF NEW.account_id IS NOT DISTINCT FROM OLD.account_id THEN
    RETURN NEW;
  END IF;

  SELECT access_revoked_at INTO v_revoked
    FROM accounts WHERE id = NEW.account_id;

  IF v_revoked IS NOT NULL THEN
    RAISE EXCEPTION 'Account access has been withdrawn'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.guard_join_revoked_account() OWNER TO postgres;

DROP TRIGGER IF EXISTS guard_join_revoked_account ON profiles;
CREATE TRIGGER guard_join_revoked_account
  BEFORE UPDATE OF account_id ON profiles
  FOR EACH ROW EXECUTE FUNCTION guard_join_revoked_account();

-- ------------------------------------------------------------
-- 2. An account that still holds work cannot be deleted
-- ------------------------------------------------------------
-- The catalogue is the source of truth for "what tables hold a tenant's
-- data", so this cannot drift the way a hand-written list does. The
-- platform's own tables are excluded: they describe the account rather
-- than being the customer's work, and platform_audit_log deliberately
-- outlives the account it refers to.
CREATE OR REPLACE FUNCTION public.guard_delete_account_with_data()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r RECORD;
  v_found BOOLEAN;
BEGIN
  FOR r IN
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN pg_catalog.pg_class pc ON pc.relname = c.table_name
      JOIN pg_catalog.pg_namespace pn
        ON pn.oid = pc.relnamespace AND pn.nspname = 'public'
     WHERE c.table_schema = 'public'
       AND c.column_name = 'account_id'
       AND pc.relkind = 'r'
       AND c.table_name NOT IN (
             'accounts', 'profiles', 'account_invitations',
             'platform_audit_log', 'platform_access_grants',
             'platform_account_notes'
           )
  LOOP
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM public.%I WHERE account_id = $1)', r.table_name
    ) INTO v_found USING OLD.id;

    IF v_found THEN
      RAISE EXCEPTION
        'Account still holds data in %, refusing to delete it', r.table_name
        USING ERRCODE = '23505';
    END IF;
  END LOOP;

  RETURN OLD;
END;
$$;

ALTER FUNCTION public.guard_delete_account_with_data() OWNER TO postgres;

DROP TRIGGER IF EXISTS guard_delete_account_with_data ON accounts;
CREATE TRIGGER guard_delete_account_with_data
  BEFORE DELETE ON accounts
  FOR EACH ROW EXECUTE FUNCTION guard_delete_account_with_data();

COMMENT ON FUNCTION public.guard_delete_account_with_data() IS
  'Refuses to delete an account that still holds tenant rows. Asks the catalogue rather than trusting a hand-written list, which is how the 019 emptiness check went stale and started deleting live workspaces.';
