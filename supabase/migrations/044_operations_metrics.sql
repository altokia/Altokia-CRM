-- ============================================================
-- 044 — One RPC for the whole operations panel
-- ============================================================
-- The panel that opens the working day (how many leads came in, who is
-- waiting for a human, what is overdue, what the assistant did) was
-- assembled in the browser from ten to fifteen separate PostgREST
-- queries: one per counter, each paying its own round trip, each
-- re-deriving "today" from the device clock. Two things were wrong with
-- that beyond the latency:
--
--   * "Today" and "this month" were the *browser's*. A lead created at
--     23:00 in Lima counted as tomorrow's for an admin whose laptop sat
--     in another zone, and two people looking at the same panel saw
--     different numbers. The business day belongs to accounts.timezone
--     (040) and to nothing else.
--   * Every counter's definition lived at its call site, so "open lead"
--     and "overdue" drifted between the dashboard, the queue and the
--     reports.
--
-- account_operations_metrics() answers all of it in one round trip, in
-- the account's zone, with each metric defined exactly once. The shape
-- it returns is a contract with the UI — keys are never renamed, and a
-- brand-new account gets the same keys filled with zeros, empty arrays
-- and a null longest wait, so the panel never has to null-check.
--
-- Idempotent: safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Index the counters ride on
-- ------------------------------------------------------------
-- Only one is needed. The conversations block counts every non-closed
-- thread of the account bucketed by handoff_state, and 017's
-- idx_conversations_account stops at account_id; the composite lets the
-- whole bucketing come off the index.
--
-- Everything else is already covered and a duplicate would only cost
-- write throughput: deals are read per account with no status predicate
-- (the counters are FILTER clauses over one pass, so idx_deals_account
-- from 017 is the access path, and the by-label subquery rides 043's
-- idx_deals_label); tasks are read per account restricted to the three
-- open statuses, which is exactly 041's partial idx_tasks_account_open;
-- and ai_usage_log has 033's (account_id, created_at DESC), which is the
-- "this account's rows since the start of the local day" lookup.

CREATE INDEX IF NOT EXISTS idx_conversations_account_handoff
  ON conversations(account_id, handoff_state);

-- ------------------------------------------------------------
-- 1b. One-time repair: closed_at on deals closed before 043
-- ------------------------------------------------------------
-- 043 added deals.closed_at and let the derive_deal_status_from_stage
-- trigger fill it, but the trigger only fires when the status or the
-- stage actually changes — and 043's own backfill skipped rows whose
-- status was already correct. So every deal that was won or lost before
-- phase 3 shipped kept closed_at NULL, and the two headline numbers of
-- this panel (won_this_month and its value, both keyed on closed_at)
-- would read zero for the whole first month on any account with history.
--
-- updated_at is the closest trace of when that status was last written.
-- The IS NULL predicate makes a re-run a no-op.
UPDATE deals
   SET closed_at = COALESCE(updated_at, created_at, NOW())
 WHERE status IN ('won', 'lost')
   AND closed_at IS NULL;

-- ------------------------------------------------------------
-- 2. The RPC
-- ------------------------------------------------------------
-- No parameters, on purpose. The account is resolved inside the
-- function from the caller's profile, so there is nothing a client can
-- forge; SECURITY DEFINER then lets the counts run past RLS while every
-- subquery still filters on that one resolved account_id.
--
-- A caller with no profile row (or the service role, whose auth.uid()
-- is NULL) leaves v_account NULL, every `account_id = v_account`
-- predicate matches nothing, and the zero-filled object falls out of the
-- same code path — which is why there is no separate "empty" branch to
-- keep in step with the contract.
CREATE OR REPLACE FUNCTION public.account_operations_metrics()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account       UUID;
  v_tz            TEXT;
  v_now           TIMESTAMPTZ := now();
  v_today         DATE;
  v_day_start     TIMESTAMPTZ;
  v_day_end       TIMESTAMPTZ;
  v_month_start   TIMESTAMPTZ;
  v_month_end     TIMESTAMPTZ;
  v_leads         JSONB;
  v_by_label      JSONB;
  v_conversations JSONB;
  v_tasks         JSONB;
  v_by_action     JSONB;
  v_ai            JSONB;
  v_handoffs      BIGINT;
  v_is_admin      BOOLEAN;
BEGIN
  SELECT p.account_id, NULLIF(a.timezone, '')
    INTO v_account, v_tz
    FROM profiles p
    LEFT JOIN accounts a ON a.id = p.account_id
   WHERE p.user_id = auth.uid();

  v_tz := COALESCE(v_tz, 'UTC');

  -- accounts.timezone is validated in the app, never by a CHECK (a CHECK
  -- cannot consult pg_timezone_names — see 040). A zone name that got in
  -- by some other route must not take the whole panel down with it, so a
  -- rejected one degrades to UTC instead of raising.
  BEGIN
    v_today := (v_now AT TIME ZONE v_tz)::date;
  EXCEPTION WHEN OTHERS THEN
    v_tz := 'UTC';
    v_today := (v_now AT TIME ZONE v_tz)::date;
  END;

  -- The business day, as absolute instants. Everything below compares
  -- timestamptz against these, so "today" is the account's day even when
  -- the server, the browser and the customer are in three zones.
  v_day_start   := v_today::timestamp AT TIME ZONE v_tz;
  v_day_end     := (v_today + 1)::timestamp AT TIME ZONE v_tz;
  v_month_start := date_trunc('month', v_today::timestamp) AT TIME ZONE v_tz;
  v_month_end   := (date_trunc('month', v_today::timestamp) + INTERVAL '1 month') AT TIME ZONE v_tz;

  -- ---- leads (= deals, since 043) ----
  -- One pass over the account's deals; each counter is a FILTER rather
  -- than its own query. NULL follow_up_at / closed_at drop out of the
  -- comparisons on their own, so no counter needs an IS NOT NULL guard.
  SELECT jsonb_build_object(
           'new_today',
             COUNT(*) FILTER (WHERE d.created_at >= v_day_start AND d.created_at < v_day_end),
           'open',
             COUNT(*) FILTER (WHERE d.status = 'open'),
           'high_priority',
             COUNT(*) FILTER (WHERE d.status = 'open' AND d.priority IN ('high', 'urgent')),
           'follow_up_overdue',
             COUNT(*) FILTER (WHERE d.status = 'open' AND d.follow_up_at < v_now),
           'follow_up_today',
             COUNT(*) FILTER (WHERE d.status = 'open'
                                AND d.follow_up_at >= v_now
                                AND d.follow_up_at < v_day_end),
           'won_this_month',
             COUNT(*) FILTER (WHERE d.status = 'won'
                                AND d.closed_at >= v_month_start
                                AND d.closed_at < v_month_end),
           'won_value_this_month',
             COALESCE(SUM(d.value) FILTER (WHERE d.status = 'won'
                                             AND d.closed_at >= v_month_start
                                             AND d.closed_at < v_month_end), 0)
         )
    INTO v_leads
    FROM deals d
   WHERE d.account_id = v_account;

  -- Every label the account defined, in its configured order, including
  -- the ones nothing is sitting on. A zero is information ("nobody is
  -- pending payment"), and hiding it is the UI's decision, not the
  -- database's.
  SELECT COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'key',   ll.key,
               'name',  ll.name,
               'color', ll.color,
               'count', (
                 SELECT COUNT(*)
                   FROM deals d
                  WHERE d.account_id = v_account
                    AND d.status = 'open'
                    AND d.label_key = ll.key
               )
             )
             ORDER BY ll.position, ll.name
           ),
           '[]'::jsonb
         )
    INTO v_by_label
    FROM lead_labels ll
   WHERE ll.account_id = v_account;

  -- ---- conversations ----
  -- Closed threads are excluded outright: the panel is about live work,
  -- and a closed thread is neither waiting nor being handled.
  SELECT jsonb_build_object(
           'waiting_for_human',
             COUNT(*) FILTER (WHERE c.handoff_state = 'waiting_for_human'),
           'ai_active',
             COUNT(*) FILTER (WHERE c.handoff_state = 'ai_active'),
           'human_active',
             COUNT(*) FILTER (WHERE c.handoff_state = 'human_active'),
           'unassigned_waiting',
             COUNT(*) FILTER (WHERE c.handoff_state = 'waiting_for_human'
                                AND c.assigned_agent_id IS NULL),
           -- The oldest thread still waiting, in whole minutes. NULL —
           -- not 0 — when nobody is waiting, so the UI can tell "nobody
           -- is queued" from "somebody just got queued".
           'longest_wait_minutes',
             MAX(FLOOR(EXTRACT(EPOCH FROM (v_now - c.waiting_since)) / 60)::int)
               FILTER (WHERE c.handoff_state = 'waiting_for_human')
         )
    INTO v_conversations
    FROM conversations c
   WHERE c.account_id = v_account
     AND c.handoff_state <> 'closed';

  -- ---- tasks ----
  -- The three open statuses (041) are the definition of "open work"
  -- everywhere; done and cancelled never show up in the panel.
  -- overdue and due_today are disjoint, mirroring the lead follow-ups
  -- above: a task due at 09:00 read at 15:00 is late, not "still to do
  -- today". Two counters that double-count the same row read as eight
  -- pieces of work when there are five.
  SELECT jsonb_build_object(
           'open',      COUNT(*),
           'pending',   COUNT(*) FILTER (WHERE t.status = 'pending'),
           'overdue',   COUNT(*) FILTER (WHERE t.due_at < v_now),
           'due_today', COUNT(*) FILTER (WHERE t.due_at >= v_now
                                           AND t.due_at < v_day_end)
         )
    INTO v_tasks
    FROM tasks t
   WHERE t.account_id = v_account
     AND t.status IN ('pending', 'assigned', 'in_progress');

  -- action_type is free text (a new kind of action is a constant in the
  -- app, not a migration), so the breakdown is whatever the account
  -- actually has, biggest pile first.
  SELECT COALESCE(
           jsonb_agg(
             jsonb_build_object('action_type', g.action_type, 'count', g.cnt)
             ORDER BY g.cnt DESC, g.action_type
           ),
           '[]'::jsonb
         )
    INTO v_by_action
    FROM (
      SELECT t.action_type, COUNT(*)::int AS cnt
        FROM tasks t
       WHERE t.account_id = v_account
         AND t.status IN ('pending', 'assigned', 'in_progress')
       GROUP BY t.action_type
    ) g;

  -- ---- assistant ----
  -- Handoffs are counted as HUMAN_CHAT tasks opened today rather than
  -- read from a log of handoff transitions, because no such log exists:
  -- handoff_state (040) holds the current state only, and its history is
  -- not kept. The HUMAN_CHAT task the state trigger opens (041) is the
  -- closest durable trace of "the assistant stood down today", and it is
  -- the number a supervisor actually acts on. If a transitions log is
  -- ever added, this is the one metric to move onto it.
  SELECT COUNT(*)
    INTO v_handoffs
    FROM tasks t
   WHERE t.account_id = v_account
     AND t.action_type = 'HUMAN_CHAT'
     AND t.created_at >= v_day_start
     AND t.created_at < v_day_end;

  -- ai_usage_log is the one table here RLS reserves for admins (033:
  -- "spend visibility is settings/billing-class"); every other table the
  -- function reads is member-readable. SECURITY DEFINER runs past RLS,
  -- so the check the policy would have made has to be made here — or
  -- this panel would quietly hand an agent the numbers the schema
  -- withholds from them. `restricted` says so out loud instead of
  -- returning a zero the viewer would read as "the assistant did
  -- nothing today".
  v_is_admin := COALESCE(is_account_member(v_account, 'admin'), FALSE);

  IF v_is_admin THEN
    SELECT jsonb_build_object(
             'replies_today',               COUNT(*),
             'conversations_handled_today', COUNT(DISTINCT u.conversation_id),
             'restricted',                  FALSE
           )
      INTO v_ai
      FROM ai_usage_log u
     WHERE u.account_id = v_account
       AND u.mode = 'auto_reply'
       AND u.created_at >= v_day_start
       AND u.created_at < v_day_end;
  ELSE
    v_ai := jsonb_build_object(
              'replies_today',               0,
              'conversations_handled_today', 0,
              'restricted',                  TRUE
            );
  END IF;

  -- Handoffs stay visible to everyone: they are counted off tasks, which
  -- every member can already read, and "the assistant stood down N times
  -- today" is the number an agent acts on.
  v_ai := v_ai || jsonb_build_object('handoffs_today', v_handoffs);

  RETURN jsonb_build_object(
    'leads',         v_leads || jsonb_build_object('by_label', v_by_label),
    'conversations', v_conversations,
    'tasks',         v_tasks || jsonb_build_object('by_action_type', v_by_action),
    'ai',            v_ai,
    'timezone',      v_tz,
    -- Stamped here, not in the browser: the panel's "as of" has to come
    -- from the same clock the counters above were measured against.
    'generated_at',  v_now
  );
END;
$$;

COMMENT ON FUNCTION public.account_operations_metrics() IS
  'Every counter the operations panel shows, in one round trip, scoped '
  'to the caller''s account and computed in accounts.timezone. The key '
  'shape is a contract with the UI: a brand-new account returns the same '
  'keys with zeros, empty arrays and a null longest_wait_minutes.';

REVOKE ALL ON FUNCTION public.account_operations_metrics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.account_operations_metrics() TO authenticated;
