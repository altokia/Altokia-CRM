-- ============================================================
-- 051 — Restore what 049 dropped from the assignment notification
-- ============================================================
-- 049 rewrote notify_conversation_assigned to add one guard (stand down
-- when a HUMAN_CHAT task already covers the thread, so one job stops
-- raising two alerts). Rewriting the whole body to add a guard lost
-- three things the original had, and each of them is visible to a user:
--
--   * The self-assignment skip. Taking a conversation yourself now
--     notified you about it — the one case where there is nothing to
--     tell anyone.
--   * `contact_id` and `actor_user_id` on the row. The notifications
--     screen reads both to say "Ana te pasó la conversación con Juan";
--     without them every assignment fell back to the generic sentence,
--     and the screen had no way to link the contact.
--   * The EXCEPTION handler. A failure while building the notification
--     could take the assignment down with it, which inverts the
--     priority: the assignment is the operation, the alert is the
--     courtesy.
--
-- This restores all three and keeps the dedup guard.
--
-- Idempotent: safe to re-run.
-- ============================================================

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

  -- Taking a chat yourself needs no announcement.
  IF auth.uid() IS NOT NULL AND auth.uid() = NEW.assigned_agent_id THEN
    RETURN NEW;
  END IF;

  -- A thread queued for a person already carries a HUMAN_CHAT task, and
  -- that task raises its own notification when it is assigned. Two
  -- alerts for one job train people to ignore the badge.
  IF EXISTS (
    SELECT 1 FROM tasks t
     WHERE t.conversation_id = NEW.id
       AND t.action_type = 'HUMAN_CHAT'
       AND t.status IN ('pending', 'assigned', 'in_progress')
  ) THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(NULLIF(name, ''), phone) INTO v_contact_name
    FROM contacts WHERE id = NEW.contact_id;

  IF auth.uid() IS NOT NULL THEN
    SELECT full_name INTO v_actor_name
      FROM profiles WHERE user_id = auth.uid();
  END IF;

  INSERT INTO notifications (
    account_id, user_id, type, conversation_id, contact_id,
    actor_user_id, title, body
  ) VALUES (
    NEW.account_id,
    NEW.assigned_agent_id,
    'conversation_assigned',
    NEW.id,
    NEW.contact_id,
    auth.uid(),
    'New conversation assigned',
    COALESCE(v_actor_name, 'Someone') || ' assigned you a conversation with '
      || COALESCE(v_contact_name, 'a contact')
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- The assignment is the operation; the alert is the courtesy. Never
  -- let the courtesy fail the operation.
  RAISE WARNING 'Failed to create assignment notification for conversation %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION notify_conversation_assigned() OWNER TO postgres;
