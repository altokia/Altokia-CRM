-- ============================================================
-- Phase 0 foundations — safe to re-run (idempotent).
--
-- Groundwork for advisor schedules, schedule-aware routing, work
-- queues and a natural-language assistant. Nothing here changes what
-- a user sees yet; it gives the next migrations something coherent to
-- build on:
--
--   1. accounts.timezone + accounts.terminology — every "is it 15:00
--      for this business?" and every "call it Matriculado, not Won"
--      needs a per-account home. accounts already carries the one
--      per-account setting that exists (default_currency, 021), so the
--      pattern is copied rather than a settings table invented.
--
--   2. conversations.handoff_state — who owns the thread. Until now
--      this was implied by three columns (status='pending',
--      assigned_agent_id, ai_autoreply_disabled) written by five
--      different places, and "waiting for a human" was
--      indistinguishable from "paused by an agent". One explicit state
--      lets the AI, the flows engine, automations and the inbox agree.
--
--   3. conversations.assigned_agent_id gains the foreign key it never
--      had. Removing a teammate left threads assigned to a ghost; now
--      they fall back to unassigned.
--
--   4. notifications.type and ai_usage_log.mode were CHECKed to a
--      single value / two values. Widened to the sets the work queue
--      and the structured-AI calls will need, so those features don't
--      each ship a constraint migration.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Per-account operational settings
-- ------------------------------------------------------------

-- IANA zone name (e.g. 'America/Lima'). Validated in the app against
-- Intl.supportedValuesOf('timeZone'); a CHECK cannot consult
-- pg_timezone_names. 'UTC' keeps existing installs behaviourally
-- unchanged until an admin sets theirs.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC';

COMMENT ON COLUMN accounts.timezone IS
  'IANA time zone the business operates in. Advisor schedules, '
  'business hours and "review pending tasks at shift start" are all '
  'evaluated in this zone — never in the server''s.';

-- Free-form label overrides, read through the UI''s terminology hook
-- with the locale dictionary as fallback. Known keys so far:
-- won_label, lost_label, role_label, lead_label, deal_label. Kept as
-- JSONB so adding a label is not a migration.
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS terminology JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE accounts
  DROP CONSTRAINT IF EXISTS accounts_terminology_is_object;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_terminology_is_object
  CHECK (jsonb_typeof(terminology) = 'object');

COMMENT ON COLUMN accounts.terminology IS
  'Per-business vocabulary overrides ({"won_label": "Matriculado", '
  '"role_label": "asesor", ...}). Internal enums never change; only '
  'what the UI calls them.';

-- ------------------------------------------------------------
-- 2. Explicit handoff state on conversations
-- ------------------------------------------------------------

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS handoff_state TEXT NOT NULL DEFAULT 'ai_active';
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS handoff_reason TEXT;
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS waiting_since TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversations_handoff_state_check'
      AND conrelid = 'conversations'::regclass
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_handoff_state_check
      CHECK (handoff_state IN ('ai_active', 'waiting_for_human', 'human_active', 'closed'));
  END IF;
END
$$;

COMMENT ON COLUMN conversations.handoff_state IS
  'Who owns the thread: ai_active (assistant may reply), '
  'waiting_for_human (assistant stood down, nobody has picked it up), '
  'human_active (a teammate owns it; assistant is silent), closed. '
  'Written only through lib/conversations/handoff.ts.';
COMMENT ON COLUMN conversations.handoff_reason IS
  'Why the last transition happened (ai_requested, ai_cap_reached, '
  'flow_handoff, agent_replied, agent_took_over, manual_resume, ...). '
  'Free text so new reasons need no migration.';
COMMENT ON COLUMN conversations.waiting_since IS
  'Set while handoff_state = waiting_for_human; drives queue age and '
  'the "how long has this lead been waiting" metric.';

-- Backfill from the columns that used to imply the state. Rows that
-- match none of the conditions were, and stay, ai_active. Re-running
-- maps the same rows to the same values, so this is idempotent.
UPDATE conversations
SET handoff_state = CASE
      WHEN status = 'closed' THEN 'closed'
      WHEN assigned_agent_id IS NOT NULL THEN 'human_active'
      WHEN ai_autoreply_disabled THEN 'waiting_for_human'
      ELSE 'ai_active'
    END,
    waiting_since = CASE
      WHEN status <> 'closed' AND assigned_agent_id IS NULL AND ai_autoreply_disabled
        THEN COALESCE(waiting_since, updated_at, now())
      ELSE NULL
    END
WHERE handoff_state = 'ai_active'
  AND (status = 'closed' OR assigned_agent_id IS NOT NULL OR ai_autoreply_disabled);

-- The work queue asks "what is waiting, oldest first" per account.
CREATE INDEX IF NOT EXISTS idx_conversations_waiting_for_human
  ON conversations (account_id, waiting_since)
  WHERE handoff_state = 'waiting_for_human';

-- ------------------------------------------------------------
-- 3. Foreign key for the assignee
-- ------------------------------------------------------------

-- Standard for every assignee column going forward: auth.users(id)
-- (= profiles.user_id), which is what notifications.user_id,
-- ai_configs.handoff_agent_id and member_presence.user_id already use.
-- Clear values that no longer resolve before adding the constraint,
-- otherwise the ALTER fails on the first ghost.
UPDATE conversations c
SET assigned_agent_id = NULL
WHERE assigned_agent_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = c.assigned_agent_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversations_assigned_agent_id_fkey'
      AND conrelid = 'conversations'::regclass
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_assigned_agent_id_fkey
      FOREIGN KEY (assigned_agent_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END
$$;

-- ------------------------------------------------------------
-- 4. Widen the two CHECKs that were pinned to today''s features
-- ------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'notifications_type_check' AND conrelid = 'notifications'::regclass
  ) THEN
    ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
  END IF;
END
$$;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'conversation_assigned',
    'conversation_waiting',
    'task_assigned',
    'task_due',
    'follow_up_due',
    'review_required'
  ));

-- Structured payload for client-side rendering in the user''s language
-- and terminology, instead of English sentences baked in by a trigger.
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN notifications.metadata IS
  'Type-specific fields (task_id, action_type, priority, ...). The UI '
  'renders title/body from type + metadata; the stored title/body are '
  'a plain-text fallback.';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_usage_log_mode_check' AND conrelid = 'ai_usage_log'::regclass
  ) THEN
    ALTER TABLE ai_usage_log DROP CONSTRAINT ai_usage_log_mode_check;
  END IF;
END
$$;
ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_mode_check
  CHECK (mode IN ('auto_reply', 'draft', 'playground', 'extract', 'summary', 'assist'));
