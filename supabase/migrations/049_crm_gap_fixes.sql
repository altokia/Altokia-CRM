-- ============================================================
-- 049 — Three fixes where a feature existed but did not reach anyone
-- ============================================================
-- 1. ONE ASSIGNMENT, TWO NOTIFICATIONS.
--    A conversation waiting for a person carries a HUMAN_CHAT task
--    (041). Assigning it fires both notify_conversation_assigned (027)
--    and notify_task_assigned (041), so the advisor sees the same job
--    twice and the sidebar badge reads 2. The task notification is the
--    useful one — it lands in "Mi trabajo" — so the conversation one
--    stands down when a task already covers the same thread.
--
-- 2. A FOLLOW-UP ON A LEAD RANG FOR NOBODY.
--    `deals.follow_up_at` (043) is editable from the deal form and is
--    counted by the operations panel, but only `tasks.due_at` is swept
--    by the cron. So an advisor who set a follow-up on the lead itself
--    got a number on a dashboard and no reminder, ever. Rather than
--    add a second timer, the deal now mirrors its follow-up into a
--    FOLLOW_UP task — one clock in the system, one place that rings.
--
-- 3. A SNOOZED REMINDER NEVER RANG AGAIN (application side in the same
--    change): PATCH /api/tasks/[id] now clears due_notified_at.
--
-- Idempotent: safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Only one notification per assignment
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION notify_conversation_assigned()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contact_name TEXT;
  v_actor_name TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.assigned_agent_id IS NULL THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NEW.assigned_agent_id IS NULL
       OR NEW.assigned_agent_id IS NOT DISTINCT FROM OLD.assigned_agent_id THEN
      RETURN NEW;
    END IF;
  END IF;

  -- A thread that is queued for a person already has a HUMAN_CHAT task,
  -- and that task raises its own notification when it is assigned. Two
  -- alerts for one job trains people to ignore the badge.
  IF EXISTS (
    SELECT 1 FROM tasks t
     WHERE t.conversation_id = NEW.id
       AND t.action_type = 'HUMAN_CHAT'
       AND t.status IN ('pending', 'assigned', 'in_progress')
  ) THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(NULLIF(c.name, ''), c.phone) INTO v_contact_name
    FROM contacts c WHERE c.id = NEW.contact_id;

  SELECT COALESCE(NULLIF(p.full_name, ''), 'Someone') INTO v_actor_name
    FROM profiles p WHERE p.user_id = auth.uid();

  INSERT INTO notifications (user_id, account_id, type, title, body, conversation_id)
  VALUES (
    NEW.assigned_agent_id,
    NEW.account_id,
    'conversation_assigned',
    'Conversation assigned to you',
    COALESCE(v_actor_name, 'Someone') || ' assigned you the chat with ' ||
      COALESCE(v_contact_name, 'a contact'),
    NEW.id
  );

  RETURN NEW;
END;
$$;

ALTER FUNCTION notify_conversation_assigned() OWNER TO postgres;

-- ------------------------------------------------------------
-- 2. A lead's follow-up becomes a real reminder
-- ------------------------------------------------------------
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS follow_up_task_id UUID REFERENCES tasks(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION sync_deal_follow_up_task()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_title TEXT;
  v_assignee UUID;
  v_task UUID;
BEGIN
  IF NEW.follow_up_at IS NOT DISTINCT FROM OLD.follow_up_at THEN
    RETURN NEW;
  END IF;

  -- Cleared, or the lead closed: retire the reminder rather than leave
  -- it ringing about a deal nobody is working any more.
  IF NEW.follow_up_at IS NULL OR NEW.status <> 'open' THEN
    IF NEW.follow_up_task_id IS NOT NULL THEN
      UPDATE tasks SET status = 'cancelled'
       WHERE id = NEW.follow_up_task_id
         AND status IN ('pending', 'assigned', 'in_progress');
      NEW.follow_up_task_id := NULL;
    END IF;
    RETURN NEW;
  END IF;

  v_title := COALESCE(NULLIF(btrim(NEW.next_action), ''), 'Seguimiento: ' || NEW.title);

  -- deals.assigned_to points at profiles.id; tasks.assigned_to at
  -- auth.users.id. Mixing them up is how a task ends up assigned to
  -- nobody, silently.
  SELECT p.user_id INTO v_assignee FROM profiles p WHERE p.id = NEW.assigned_to;

  IF NEW.follow_up_task_id IS NOT NULL THEN
    UPDATE tasks
       SET due_at = NEW.follow_up_at,
           title = v_title,
           -- Re-arm: the cron only reminds about rows never notified.
           due_notified_at = NULL,
           status = CASE WHEN status IN ('done', 'cancelled')
                         THEN CASE WHEN v_assignee IS NULL THEN 'pending' ELSE 'assigned' END
                         ELSE status END,
           assigned_to = COALESCE(assigned_to, v_assignee)
     WHERE id = NEW.follow_up_task_id;
    RETURN NEW;
  END IF;

  INSERT INTO tasks (
    account_id, action_type, title, details, priority,
    contact_id, conversation_id, deal_id,
    assigned_to, status, assigned_at, created_by, source, due_at
  ) VALUES (
    NEW.account_id, 'FOLLOW_UP', v_title,
    'Seguimiento del lead ' || NEW.title, COALESCE(NEW.priority, 'normal'),
    NEW.contact_id, NEW.conversation_id, NEW.id,
    v_assignee,
    CASE WHEN v_assignee IS NULL THEN 'pending' ELSE 'assigned' END,
    CASE WHEN v_assignee IS NULL THEN NULL ELSE NOW() END,
    NULL, 'system', NEW.follow_up_at
  )
  RETURNING id INTO v_task;

  NEW.follow_up_task_id := v_task;
  RETURN NEW;
END;
$$;

ALTER FUNCTION sync_deal_follow_up_task() OWNER TO postgres;

DROP TRIGGER IF EXISTS sync_deal_follow_up_task ON deals;
CREATE TRIGGER sync_deal_follow_up_task
  BEFORE UPDATE OF follow_up_at, status ON deals
  FOR EACH ROW EXECUTE FUNCTION sync_deal_follow_up_task();

COMMENT ON COLUMN deals.follow_up_task_id IS
  'The FOLLOW_UP task mirroring follow_up_at. One clock in the system: the cron only sweeps tasks.';
