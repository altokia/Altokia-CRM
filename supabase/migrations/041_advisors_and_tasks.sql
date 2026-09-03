-- ============================================================
-- Phase 1: advisors, schedules, tasks, routing — safe to re-run.
--
-- The problem this solves, in one scenario: a lead writes at 13:00 and
-- needs the specialist whose shift is 15:00-17:00. Today that lead is
-- simply lost — nothing records "someone must call this person", and
-- nothing wakes up at 15:00. After this migration:
--
--   * advisor_profiles + advisor_schedules describe who works when,
--     on what, and how much they can carry. Availability itself is
--     computed in the app (lib/availability) from these rows plus
--     member_presence; the database only stores the facts.
--   * tasks is the work queue: one row per thing a person must do
--     (take a chat, call, follow up, quote, review...). Generic on
--     purpose — action_type is free text validated in the app, so a
--     new kind of action is a constant, not a migration.
--   * A trigger turns every conversation that enters waiting_for_human
--     into an open HUMAN_CHAT task, and closes that task when a person
--     takes the thread — so all five handoff writers feed the queue
--     without knowing it exists.
--   * assignment_events is the audit trail of who was chosen, by which
--     strategy, and who else was considered.
--   * accounts.routing holds the per-business strategy and fallback.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Advisor profile (1:1 with a member, keyed like member_presence)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS advisor_profiles (
  user_id               UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id            UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  department            TEXT,
  -- Free-text tags the routing service matches against task hints
  -- ("niños", "empresas", "alquiler"...). Per-business vocabulary.
  specialties           TEXT[] NOT NULL DEFAULT '{}',
  -- Catalog items this advisor handles (catalog arrives in phase 2;
  -- kept FK-less so the two phases stay independent).
  item_ids              UUID[] NOT NULL DEFAULT '{}',
  -- Max concurrent threads + in-progress tasks before routing skips them.
  capacity              INTEGER NOT NULL DEFAULT 10 CHECK (capacity >= 0),
  -- Manual override of the schedule: NULL follows the schedule.
  availability_override TEXT CHECK (availability_override IN ('available', 'busy', 'off')),
  accepts_assignments   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_advisor_profiles_account ON advisor_profiles(account_id);

COMMENT ON TABLE advisor_profiles IS
  'Routing-relevant attributes of a team member. Identity and role stay '
  'on profiles; this row exists only for members who take assignments.';

ALTER TABLE advisor_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS advisor_profiles_select ON advisor_profiles;
CREATE POLICY advisor_profiles_select ON advisor_profiles FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS advisor_profiles_insert ON advisor_profiles;
CREATE POLICY advisor_profiles_insert ON advisor_profiles FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS advisor_profiles_update ON advisor_profiles;
CREATE POLICY advisor_profiles_update ON advisor_profiles FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS advisor_profiles_delete ON advisor_profiles;
CREATE POLICY advisor_profiles_delete ON advisor_profiles FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at_advisor_profiles ON advisor_profiles;
CREATE TRIGGER set_updated_at_advisor_profiles
  BEFORE UPDATE ON advisor_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- An advisor may flip their OWN override ("no disponible ahora") without
-- admin rights. SECURITY DEFINER so it works despite admin-only RLS;
-- the account is read from the caller's profile, never from the client.
CREATE OR REPLACE FUNCTION public.set_my_availability(p_override TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account UUID;
BEGIN
  IF p_override IS NOT NULL AND p_override NOT IN ('available', 'busy', 'off') THEN
    RAISE EXCEPTION 'invalid availability override: %', p_override;
  END IF;
  SELECT account_id INTO v_account FROM profiles WHERE user_id = auth.uid();
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'caller has no account';
  END IF;
  INSERT INTO advisor_profiles (user_id, account_id, availability_override)
  VALUES (auth.uid(), v_account, p_override)
  ON CONFLICT (user_id) DO UPDATE
    SET availability_override = EXCLUDED.availability_override,
        updated_at = now();
END;
$$;
REVOKE ALL ON FUNCTION public.set_my_availability(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_my_availability(TEXT) TO authenticated;

-- ------------------------------------------------------------
-- 2. Weekly schedule windows
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS advisor_schedules (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- 0 = Sunday ... 6 = Saturday (JavaScript's Date#getDay()).
  weekday     SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  -- Wall-clock times in accounts.timezone. end is exclusive. No
  -- overnight windows in v1: split a 22:00-02:00 shift into two rows.
  start_time  TIME NOT NULL,
  end_time    TIME NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT advisor_schedules_window_check CHECK (start_time < end_time)
);

CREATE INDEX IF NOT EXISTS idx_advisor_schedules_user
  ON advisor_schedules(account_id, user_id, weekday);

COMMENT ON TABLE advisor_schedules IS
  'One row per working window. Several rows per weekday allow split '
  'shifts. Evaluated in the account time zone by lib/availability.';

ALTER TABLE advisor_schedules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS advisor_schedules_select ON advisor_schedules;
CREATE POLICY advisor_schedules_select ON advisor_schedules FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS advisor_schedules_insert ON advisor_schedules;
CREATE POLICY advisor_schedules_insert ON advisor_schedules FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS advisor_schedules_update ON advisor_schedules;
CREATE POLICY advisor_schedules_update ON advisor_schedules FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS advisor_schedules_delete ON advisor_schedules;
CREATE POLICY advisor_schedules_delete ON advisor_schedules FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------
-- 3. Tasks — the work queue
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id  UUID REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id       UUID REFERENCES contacts(id) ON DELETE SET NULL,
  -- The lead this task belongs to (deals become the generic lead in phase 3).
  deal_id          UUID REFERENCES deals(id) ON DELETE SET NULL,
  -- HUMAN_CHAT | CALL | FOLLOW_UP | APPOINTMENT | QUOTE | REVIEW_REQUIRED |
  -- AI_CONTINUE | ... — validated in the app (lib/tasks), extensible.
  action_type      TEXT NOT NULL,
  title            TEXT NOT NULL,
  details          TEXT,
  priority         TEXT NOT NULL DEFAULT 'normal'
                     CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'assigned', 'in_progress', 'done', 'cancelled')),
  assigned_to      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Who asked for this: a person, the assistant, an automation, a flow,
  -- or the system (the waiting_for_human trigger below).
  source           TEXT NOT NULL DEFAULT 'manual'
                     CHECK (source IN ('manual', 'ai', 'automation', 'flow', 'system')),
  due_at           TIMESTAMPTZ,
  -- {"after": "15:00", "before": "18:00"} in the account time zone —
  -- the customer's preferred contact window.
  preferred_window JSONB,
  -- Hints for the routing service: {"department": "...",
  -- "specialties": [...], "item_id": "...", "previous_advisor_id": "..."}.
  routing          JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Snapshot rendered on the queue card (interest, need, AI summary...).
  summary          JSONB NOT NULL DEFAULT '{}'::jsonb,
  assigned_at      TIMESTAMPTZ,
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  -- Set once the due reminder has been sent, so the cron sends it once.
  due_notified_at  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tasks_routing_is_object CHECK (jsonb_typeof(routing) = 'object'),
  CONSTRAINT tasks_summary_is_object CHECK (jsonb_typeof(summary) = 'object')
);

-- Queue reads: "open work for this account / for me", oldest and most
-- urgent first; due reminders; and the per-conversation lookup the
-- handoff trigger needs.
CREATE INDEX IF NOT EXISTS idx_tasks_account_open
  ON tasks(account_id, priority, created_at)
  WHERE status IN ('pending', 'assigned', 'in_progress');
CREATE INDEX IF NOT EXISTS idx_tasks_assignee_open
  ON tasks(assigned_to, created_at)
  WHERE status IN ('assigned', 'in_progress');
CREATE INDEX IF NOT EXISTS idx_tasks_due
  ON tasks(account_id, due_at)
  WHERE status IN ('pending', 'assigned', 'in_progress') AND due_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_conversation
  ON tasks(conversation_id)
  WHERE conversation_id IS NOT NULL;

COMMENT ON TABLE tasks IS
  'One row per thing a person must do. Generic across industries: the '
  'academy''s "call the enrolment lead" and the agency''s "call the '
  'viewing lead" are both action_type = CALL with different routing '
  'hints and summaries.';

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tasks_select ON tasks;
CREATE POLICY tasks_select ON tasks FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS tasks_insert ON tasks;
CREATE POLICY tasks_insert ON tasks FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS tasks_update ON tasks;
CREATE POLICY tasks_update ON tasks FOR UPDATE
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS tasks_delete ON tasks;
CREATE POLICY tasks_delete ON tasks FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at_tasks ON tasks;
CREATE TRIGGER set_updated_at_tasks
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Realtime so "Mi trabajo" updates live, like the inbox.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'tasks'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE tasks;
  END IF;
END $$;

-- ------------------------------------------------------------
-- 4. Notify the assignee (same shape as notify_conversation_assigned)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION notify_task_assigned()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.assigned_to IS NULL THEN RETURN NEW; END IF;
  ELSE
    IF NEW.assigned_to IS NULL
       OR NEW.assigned_to IS NOT DISTINCT FROM OLD.assigned_to THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Self-assignment ("Atender") needs no notification.
  IF auth.uid() IS NOT NULL AND auth.uid() = NEW.assigned_to THEN
    RETURN NEW;
  END IF;

  -- title/body are a plain fallback; the UI renders from type + metadata
  -- in the user's language and the account's terminology.
  INSERT INTO notifications (
    account_id, user_id, type, conversation_id, contact_id,
    actor_user_id, title, body, metadata
  ) VALUES (
    NEW.account_id,
    NEW.assigned_to,
    'task_assigned',
    NEW.conversation_id,
    NEW.contact_id,
    auth.uid(),
    NEW.title,
    NEW.details,
    jsonb_build_object(
      'task_id', NEW.id,
      'action_type', NEW.action_type,
      'priority', NEW.priority,
      'due_at', NEW.due_at
    )
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to create task notification for task %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION notify_task_assigned() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_task_assigned ON tasks;
CREATE TRIGGER on_task_assigned
  AFTER INSERT OR UPDATE OF assigned_to ON tasks
  FOR EACH ROW EXECUTE FUNCTION notify_task_assigned();

-- ------------------------------------------------------------
-- 5. waiting_for_human ⇄ HUMAN_CHAT task
--
-- Every handoff writer already moves conversations.handoff_state (040).
-- This trigger turns that state into queue work so none of them has to
-- know about tasks:
--   → waiting_for_human : open a HUMAN_CHAT task if none is open
--   → human_active      : hand any open HUMAN_CHAT task to the assignee
--   → ai_active/closed  : cancel any open HUMAN_CHAT task
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION sync_human_chat_task()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contact_name TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.handoff_state IS NOT DISTINCT FROM OLD.handoff_state
     AND NEW.assigned_agent_id IS NOT DISTINCT FROM OLD.assigned_agent_id THEN
    RETURN NEW;
  END IF;

  IF NEW.handoff_state = 'waiting_for_human' THEN
    IF NOT EXISTS (
      SELECT 1 FROM tasks
      WHERE conversation_id = NEW.id AND action_type = 'HUMAN_CHAT'
        AND status IN ('pending', 'assigned', 'in_progress')
    ) THEN
      SELECT COALESCE(NULLIF(name, ''), phone) INTO v_contact_name
      FROM contacts WHERE id = NEW.contact_id;
      INSERT INTO tasks (
        account_id, conversation_id, contact_id, action_type, title, details,
        priority, status, source, summary
      ) VALUES (
        NEW.account_id, NEW.id, NEW.contact_id, 'HUMAN_CHAT',
        COALESCE(v_contact_name, 'Conversation'),
        NEW.ai_handoff_summary,
        'high', 'pending',
        CASE WHEN NEW.handoff_reason LIKE 'ai_%' THEN 'ai'
             WHEN NEW.handoff_reason LIKE 'flow_%' THEN 'flow'
             WHEN NEW.handoff_reason LIKE 'automation_%' THEN 'automation'
             ELSE 'system' END,
        jsonb_build_object('handoff_reason', NEW.handoff_reason)
      );
    END IF;

  ELSIF NEW.handoff_state = 'human_active' THEN
    UPDATE tasks
    SET status = 'in_progress',
        assigned_to = COALESCE(NEW.assigned_agent_id, assigned_to),
        assigned_at = COALESCE(assigned_at, now()),
        started_at = COALESCE(started_at, now())
    WHERE conversation_id = NEW.id AND action_type = 'HUMAN_CHAT'
      AND status IN ('pending', 'assigned', 'in_progress');

  ELSE
    UPDATE tasks
    SET status = 'cancelled', completed_at = now()
    WHERE conversation_id = NEW.id AND action_type = 'HUMAN_CHAT'
      AND status IN ('pending', 'assigned');
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'sync_human_chat_task failed for conversation %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;
ALTER FUNCTION sync_human_chat_task() OWNER TO postgres;

DROP TRIGGER IF EXISTS on_conversation_handoff_state ON conversations;
CREATE TRIGGER on_conversation_handoff_state
  AFTER INSERT OR UPDATE OF handoff_state, assigned_agent_id ON conversations
  FOR EACH ROW EXECUTE FUNCTION sync_human_chat_task();

-- ------------------------------------------------------------
-- 6. Assignment audit trail
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assignment_events (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id  UUID REFERENCES conversations(id) ON DELETE CASCADE,
  task_id          UUID REFERENCES tasks(id) ON DELETE CASCADE,
  assigned_to      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  strategy         TEXT NOT NULL,
  -- routing | manual | ai | automation | flow | cron
  decided_by       TEXT NOT NULL,
  reason           TEXT,
  -- [{user_id, available, reasons[], load}] — who was considered and why not.
  candidates       JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assignment_events_account
  ON assignment_events(account_id, created_at DESC);

ALTER TABLE assignment_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS assignment_events_select ON assignment_events;
CREATE POLICY assignment_events_select ON assignment_events FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS assignment_events_insert ON assignment_events;
CREATE POLICY assignment_events_insert ON assignment_events FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

-- ------------------------------------------------------------
-- 7. Per-account routing policy
-- ------------------------------------------------------------
-- {"strategy": "least_load" | "round_robin" | "by_schedule" | ...,
--  "fallback": "queue" | "ai_continue",
--  "last_assigned_user_id": "..."}   (round-robin cursor)
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS routing JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE accounts
  DROP CONSTRAINT IF EXISTS accounts_routing_is_object;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_routing_is_object
  CHECK (jsonb_typeof(routing) = 'object');

COMMENT ON COLUMN accounts.routing IS
  'Assignment policy read by lib/routing: default strategy, what to do '
  'when nobody is available, and the round-robin cursor.';
