-- ============================================================
-- 043 — Leads on the board, closing stages, follow-ups
-- ============================================================
-- Phase 3 of the generic-CRM plan. A "lead" is not a new entity: it is
-- the existing deal, extended with what the assistant reads from the
-- conversation and what an advisor needs at a glance.
--
--   1. pipeline_stages.is_won / is_lost / probability — the business
--      says which stages mean closed; deals.status is derived from the
--      stage from now on (a trigger keeps it in step), instead of a
--      manual flag that could disagree with the column the card sits in.
--   2. deals gains priority, source, item of interest (catalog id + the
--      customer's own words), lead label, the assistant's summary, next
--      action, follow-up date, last interaction, preferred contact time
--      and closed_at.
--   3. last_interaction_at follows the conversation automatically (any
--      message on the contact's thread touches their open lead).
--
-- Idempotent: safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Closing stages
-- ------------------------------------------------------------
ALTER TABLE pipeline_stages
  ADD COLUMN IF NOT EXISTS is_won      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_lost     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS probability SMALLINT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_stages_probability_range') THEN
    ALTER TABLE pipeline_stages
      ADD CONSTRAINT pipeline_stages_probability_range
      CHECK (probability IS NULL OR (probability BETWEEN 0 AND 100));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_stages_won_xor_lost') THEN
    ALTER TABLE pipeline_stages
      ADD CONSTRAINT pipeline_stages_won_xor_lost
      CHECK (NOT (is_won AND is_lost));
  END IF;
END $$;

-- Recognise the usual closing-stage names once, so boards that already
-- exist start deriving status without anyone opening settings. Only
-- unflagged stages are touched; the business can change it any time.
UPDATE pipeline_stages
   SET is_won = TRUE
 WHERE NOT is_won AND NOT is_lost
   AND lower(btrim(name)) IN ('won', 'closed won', 'ganado', 'ganada', 'cerrado ganado', 'matriculado', 'matriculada', 'vendido', 'cerrado');

UPDATE pipeline_stages
   SET is_lost = TRUE
 WHERE NOT is_lost AND NOT is_won
   AND lower(btrim(name)) IN ('lost', 'closed lost', 'perdido', 'perdida', 'cerrado perdido', 'descartado', 'descartada');

-- ------------------------------------------------------------
-- 2. Lead columns on deals
-- ------------------------------------------------------------
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS priority               TEXT NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS source                 TEXT,
  ADD COLUMN IF NOT EXISTS item_id                UUID REFERENCES catalog_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS item_name              TEXT,
  ADD COLUMN IF NOT EXISTS label_key              TEXT,
  ADD COLUMN IF NOT EXISTS ai_summary             JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS next_action            TEXT,
  ADD COLUMN IF NOT EXISTS follow_up_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_interaction_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS preferred_contact_time TEXT,
  ADD COLUMN IF NOT EXISTS closed_at              TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deals_priority_check') THEN
    ALTER TABLE deals
      ADD CONSTRAINT deals_priority_check
      CHECK (priority IN ('low', 'normal', 'high', 'urgent'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deals_ai_summary_is_object') THEN
    ALTER TABLE deals
      ADD CONSTRAINT deals_ai_summary_is_object
      CHECK (jsonb_typeof(ai_summary) = 'object');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_deals_follow_up
  ON deals(account_id, follow_up_at)
  WHERE follow_up_at IS NOT NULL AND status = 'open';
CREATE INDEX IF NOT EXISTS idx_deals_contact_open
  ON deals(contact_id)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_deals_label
  ON deals(account_id, label_key);

-- ------------------------------------------------------------
-- 3. Status derived from the stage
-- ------------------------------------------------------------
-- Moving a deal into a won/lost stage closes it; moving it out of one
-- reopens it. A direct status write with no stage change is still
-- honoured (pipelines with no closing stage keep the old buttons), and
-- closed_at follows the status either way.
CREATE OR REPLACE FUNCTION derive_deal_status_from_stage()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_won  BOOLEAN;
  v_lost BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' OR NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
    SELECT is_won, is_lost INTO v_won, v_lost FROM pipeline_stages WHERE id = NEW.stage_id;
    IF COALESCE(v_won, FALSE) THEN
      NEW.status := 'won';
    ELSIF COALESCE(v_lost, FALSE) THEN
      NEW.status := 'lost';
    ELSIF TG_OP = 'UPDATE' AND OLD.status IN ('won', 'lost') AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
      -- Left a closing stage without an explicit status: it is open again.
      NEW.status := 'open';
    END IF;
  END IF;

  IF NEW.status IN ('won', 'lost') THEN
    IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status OR NEW.closed_at IS NULL THEN
      NEW.closed_at := NOW();
    END IF;
  ELSE
    NEW.closed_at := NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS derive_deal_status_from_stage ON deals;
CREATE TRIGGER derive_deal_status_from_stage
  BEFORE INSERT OR UPDATE OF stage_id, status ON deals
  FOR EACH ROW EXECUTE FUNCTION derive_deal_status_from_stage();

-- Flagging a stage (un)closes whatever already sits in it.
CREATE OR REPLACE FUNCTION rederive_deals_on_stage_flags()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
BEGIN
  IF NEW.is_won IS DISTINCT FROM OLD.is_won OR NEW.is_lost IS DISTINCT FROM OLD.is_lost THEN
    v_status := CASE WHEN NEW.is_won THEN 'won' WHEN NEW.is_lost THEN 'lost' ELSE 'open' END;
    UPDATE deals
       SET status = v_status
     WHERE stage_id = NEW.id
       AND status IS DISTINCT FROM v_status;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS rederive_deals_on_stage_flags ON pipeline_stages;
CREATE TRIGGER rederive_deals_on_stage_flags
  AFTER UPDATE OF is_won, is_lost ON pipeline_stages
  FOR EACH ROW EXECUTE FUNCTION rederive_deals_on_stage_flags();

-- ------------------------------------------------------------
-- 4. last_interaction_at follows the thread
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_lead_on_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_at TIMESTAMPTZ := COALESCE(NEW.created_at, NOW());
BEGIN
  UPDATE deals d
     SET last_interaction_at = v_at
    FROM conversations c
   WHERE c.id = NEW.conversation_id
     AND d.contact_id = c.contact_id
     AND d.status = 'open'
     AND (d.last_interaction_at IS NULL OR d.last_interaction_at < v_at);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS touch_lead_on_message ON messages;
CREATE TRIGGER touch_lead_on_message
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION touch_lead_on_message();

-- ------------------------------------------------------------
-- 5. Backfill from what is already known
-- ------------------------------------------------------------
UPDATE deals d
   SET last_interaction_at = c.last_message_at
  FROM conversations c
 WHERE c.contact_id = d.contact_id
   AND d.last_interaction_at IS NULL
   AND c.last_message_at IS NOT NULL;

UPDATE deals d
   SET label_key = i.lead_label_key,
       item_name = COALESCE(d.item_name, i.item_name),
       next_action = COALESCE(d.next_action, i.next_action),
       preferred_contact_time = COALESCE(d.preferred_contact_time, i.preferred_contact_time)
  FROM conversation_insights i
 WHERE i.contact_id = d.contact_id
   AND d.status = 'open'
   AND d.label_key IS NULL
   AND i.lead_label_key IS NOT NULL;

-- Deals already sitting in a stage flagged above get their status now.
UPDATE deals d
   SET status = CASE WHEN s.is_won THEN 'won' WHEN s.is_lost THEN 'lost' ELSE d.status END
  FROM pipeline_stages s
 WHERE s.id = d.stage_id
   AND (s.is_won OR s.is_lost)
   AND d.status IS DISTINCT FROM CASE WHEN s.is_won THEN 'won' ELSE 'lost' END;

COMMENT ON COLUMN deals.label_key IS 'lead_labels.key — the commercial reading of this lead (mirrors conversation_insights)';
COMMENT ON COLUMN deals.ai_summary IS 'What the assistant last understood: {text, intent, intent_level, need, next_action, needs_human, updated_at}';
COMMENT ON COLUMN pipeline_stages.is_won IS 'Deals moved into this stage are closed as won (status derived by trigger)';
COMMENT ON COLUMN pipeline_stages.is_lost IS 'Deals moved into this stage are closed as lost (status derived by trigger)';
