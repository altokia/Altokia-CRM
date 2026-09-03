-- ============================================================
-- Phase 2: natural-language assistant with structured output — safe to
-- re-run (idempotent).
--
-- What changes for the business: the assistant stops being "a prompt
-- and a reply" and becomes something that understands the customer,
-- looks things up in the business's own catalog instead of guessing,
-- labels the lead, and tells the team what to do next. The pieces:
--
--   1. ai_configs.persona — the no-prompt configuration (name, role,
--      language, tú/usted, tone, length, emojis, objective...). The
--      app compiles it into instructions; the old free-text
--      system_prompt survives as "special instructions".
--   2. ai_knowledge_documents.kind + data — typed business knowledge
--      (hours, locations, payment methods, policies, FAQs...). Kinds
--      that are always relevant are injected without retrieval.
--   3. catalog_items — products and/or services with base fields plus
--      per-business flexible attributes. "Curso de inglés · nivel
--      avanzado · virtual" and "Departamento en Miraflores · 3
--      dormitorios · 120 m²" are both rows here, differing only in
--      `attributes`. The assistant reads it through tools; it never
--      invents a price.
--   4. lead_labels — the commercial reading of a contact. Fixed
--      internal keys the assistant classifies into; display names each
--      business edits (defaults in casual Peruvian Spanish).
--   5. conversation_insights — what the assistant extracted from the
--      thread: intent, item of interest, need, priority, next action,
--      needs_human, label, preferred contact time, summary. One row per
--      conversation (= per contact), rewritten on every inbound.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Persona
-- ------------------------------------------------------------
ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS persona JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE ai_configs
  DROP CONSTRAINT IF EXISTS ai_configs_persona_is_object;
ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_persona_is_object CHECK (jsonb_typeof(persona) = 'object');

COMMENT ON COLUMN ai_configs.persona IS
  'No-prompt assistant configuration: {name, role, language, region, '
  'formality: tu|usted, tone, reply_length: short|medium|long, emojis, '
  'style, objective, special_instructions}. Compiled into instructions '
  'by lib/ai/persona.ts. system_prompt is kept as legacy free text.';

-- ------------------------------------------------------------
-- 2. Typed knowledge
-- ------------------------------------------------------------
ALTER TABLE ai_knowledge_documents
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'document';
ALTER TABLE ai_knowledge_documents
  ADD COLUMN IF NOT EXISTS data JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ai_knowledge_documents_kind_check'
      AND conrelid = 'ai_knowledge_documents'::regclass
  ) THEN
    ALTER TABLE ai_knowledge_documents
      ADD CONSTRAINT ai_knowledge_documents_kind_check
      CHECK (kind IN (
        'description', 'faq', 'policy', 'hours', 'location', 'payment',
        'warranty', 'delivery', 'requirements', 'promotion', 'document'
      ));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS ai_knowledge_documents_kind_idx
  ON ai_knowledge_documents (account_id, kind);

COMMENT ON COLUMN ai_knowledge_documents.kind IS
  'What this entry is. description/hours/location/payment are "always '
  'on": injected into every reply without retrieval. The rest are '
  'retrieved by relevance as before.';

-- ------------------------------------------------------------
-- 3. Catalog
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS catalog_items (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  category      TEXT,
  description   TEXT,
  price         NUMERIC(12, 2),
  currency      TEXT,
  -- What the assistant may say about availability. `stock` refines it
  -- for physical goods; services leave it NULL.
  availability  TEXT NOT NULL DEFAULT 'available'
                  CHECK (availability IN ('available', 'limited', 'unavailable', 'on_request')),
  stock         INTEGER CHECK (stock IS NULL OR stock >= 0),
  images        TEXT[] NOT NULL DEFAULT '{}',
  -- [{"name": "Turno mañana", "price": 350, "attributes": {...}}]
  variants      JSONB NOT NULL DEFAULT '[]'::jsonb,
  features      TEXT[] NOT NULL DEFAULT '{}',
  -- Per-business flexible fields: {"nivel": "avanzado", "modalidad":
  -- "virtual", "duracion_meses": 4} — validated in the app against
  -- catalog_attribute_definitions, never as columns.
  attributes    JSONB NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  -- Lexical search over what the assistant gets asked about. 'simple'
  -- config for the same reason as the knowledge base: any language, no
  -- English stemming. A generated column may only use IMMUTABLE
  -- functions, which rules out array_to_string(features) — features are
  -- searchable through `attributes` and `description` instead.
  fts           tsvector GENERATED ALWAYS AS (
                  to_tsvector('simple',
                    coalesce(name, '') || ' ' || coalesce(category, '') || ' ' ||
                    coalesce(description, '') || ' ' ||
                    coalesce(attributes::text, ''))
                ) STORED,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT catalog_items_variants_is_array CHECK (jsonb_typeof(variants) = 'array'),
  CONSTRAINT catalog_items_attributes_is_object CHECK (jsonb_typeof(attributes) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_catalog_items_account_status ON catalog_items (account_id, status);
CREATE INDEX IF NOT EXISTS idx_catalog_items_fts ON catalog_items USING GIN (fts);
CREATE INDEX IF NOT EXISTS idx_catalog_items_attributes ON catalog_items USING GIN (attributes);

COMMENT ON TABLE catalog_items IS
  'Products and/or services. Industry-neutral: base commercial fields '
  'plus a JSONB of attributes each business defines for itself.';

ALTER TABLE catalog_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS catalog_items_select ON catalog_items;
CREATE POLICY catalog_items_select ON catalog_items FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS catalog_items_insert ON catalog_items;
CREATE POLICY catalog_items_insert ON catalog_items FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS catalog_items_update ON catalog_items;
CREATE POLICY catalog_items_update ON catalog_items FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS catalog_items_delete ON catalog_items;
CREATE POLICY catalog_items_delete ON catalog_items FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at_catalog_items ON catalog_items;
CREATE TRIGGER set_updated_at_catalog_items
  BEFORE UPDATE ON catalog_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- The vocabulary of `attributes` for one business: which keys exist,
-- how they are labelled, what type they hold. Lets the catalog editor
-- render proper inputs and lets the assistant name attributes the way
-- the business does.
CREATE TABLE IF NOT EXISTS catalog_attribute_definitions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  label       TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text', 'number', 'boolean', 'select')),
  -- For type = select: ["presencial", "virtual"]
  options     JSONB NOT NULL DEFAULT '[]'::jsonb,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT catalog_attribute_definitions_key_format CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  CONSTRAINT catalog_attribute_definitions_unique UNIQUE (account_id, key)
);

ALTER TABLE catalog_attribute_definitions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS catalog_attribute_definitions_select ON catalog_attribute_definitions;
CREATE POLICY catalog_attribute_definitions_select ON catalog_attribute_definitions FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS catalog_attribute_definitions_insert ON catalog_attribute_definitions;
CREATE POLICY catalog_attribute_definitions_insert ON catalog_attribute_definitions FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS catalog_attribute_definitions_update ON catalog_attribute_definitions;
CREATE POLICY catalog_attribute_definitions_update ON catalog_attribute_definitions FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS catalog_attribute_definitions_delete ON catalog_attribute_definitions;
CREATE POLICY catalog_attribute_definitions_delete ON catalog_attribute_definitions FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------
-- 4. Lead labels
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_labels (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Stable key the assistant classifies into and code refers to.
  key         TEXT NOT NULL,
  -- What the business calls it. Editable at will.
  name        TEXT NOT NULL,
  -- One line the assistant reads to decide when this label applies.
  description TEXT,
  color       TEXT NOT NULL DEFAULT '#64748b',
  position    INTEGER NOT NULL DEFAULT 0,
  -- Built-in keys cannot be deleted (code may reference them); custom
  -- ones can.
  is_builtin  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lead_labels_key_format CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  CONSTRAINT lead_labels_unique UNIQUE (account_id, key)
);

ALTER TABLE lead_labels ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lead_labels_select ON lead_labels;
CREATE POLICY lead_labels_select ON lead_labels FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS lead_labels_insert ON lead_labels;
CREATE POLICY lead_labels_insert ON lead_labels FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS lead_labels_update ON lead_labels;
CREATE POLICY lead_labels_update ON lead_labels FOR UPDATE
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS lead_labels_delete ON lead_labels;
CREATE POLICY lead_labels_delete ON lead_labels FOR DELETE
  USING (is_account_member(account_id, 'admin') AND NOT is_builtin);

DROP TRIGGER IF EXISTS set_updated_at_lead_labels ON lead_labels;
CREATE TRIGGER set_updated_at_lead_labels
  BEFORE UPDATE ON lead_labels
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Defaults in casual Peruvian Spanish. Idempotent per account so it can
-- run for existing accounts now and for new accounts via the trigger.
CREATE OR REPLACE FUNCTION seed_default_lead_labels(p_account_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO lead_labels (account_id, key, name, description, color, position, is_builtin)
  VALUES
    (p_account_id, 'possible_lead',   'Posible lead',         'Preguntó algo pero todavía no se sabe si le interesa de verdad.',      '#94a3b8', 1, TRUE),
    (p_account_id, 'interested',      'Cliente interesado',   'Mostró interés claro: preguntó precio, disponibilidad o cómo empezar.', '#3b82f6', 2, TRUE),
    (p_account_id, 'new_lead',        'Lead nuevo',           'Quiere avanzar: pidió que lo llamen, una cita o cómo pagar.',           '#10b981', 3, TRUE),
    (p_account_id, 'pending_payment', 'Pago pendiente',       'Ya decidió comprar o inscribirse pero el pago aún no llega.',           '#f59e0b', 4, TRUE),
    (p_account_id, 'paid',            'Cliente que ya pagó',  'Pagó. Es cliente.',                                                     '#22c55e', 5, TRUE)
  ON CONFLICT (account_id, key) DO NOTHING;
$$;

-- Existing accounts get their defaults now.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id FROM accounts LOOP
    PERFORM seed_default_lead_labels(r.id);
  END LOOP;
END
$$;

-- New accounts get them on creation.
CREATE OR REPLACE FUNCTION seed_lead_labels_for_new_account()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM seed_default_lead_labels(NEW.id);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS on_account_created_seed_lead_labels ON accounts;
CREATE TRIGGER on_account_created_seed_lead_labels
  AFTER INSERT ON accounts
  FOR EACH ROW EXECUTE FUNCTION seed_lead_labels_for_new_account();

-- ------------------------------------------------------------
-- 5. What the assistant understood
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversation_insights (
  conversation_id        UUID PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  account_id             UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id             UUID REFERENCES contacts(id) ON DELETE CASCADE,
  intent                 TEXT,
  intent_level           TEXT CHECK (intent_level IS NULL OR intent_level IN ('low', 'medium', 'high')),
  item_id                UUID REFERENCES catalog_items(id) ON DELETE SET NULL,
  -- As the customer named it, even when it matched nothing in the catalog.
  item_name              TEXT,
  need                   TEXT,
  priority               TEXT CHECK (priority IS NULL OR priority IN ('low', 'normal', 'high', 'urgent')),
  preferences            JSONB NOT NULL DEFAULT '{}'::jsonb,
  collected_info         JSONB NOT NULL DEFAULT '{}'::jsonb,
  next_action            TEXT,
  action_type            TEXT,
  needs_human            BOOLEAN NOT NULL DEFAULT FALSE,
  lead_label_key         TEXT,
  -- A human's override wins over the assistant until the next explicit change.
  lead_label_locked      BOOLEAN NOT NULL DEFAULT FALSE,
  preferred_contact_time TEXT,
  -- {"interest", "intent_level", "asked", "contact_preference", "needs_human", "next_action", "text"}
  summary                JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_extracted_at      TIMESTAMPTZ,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT conversation_insights_preferences_is_object CHECK (jsonb_typeof(preferences) = 'object'),
  CONSTRAINT conversation_insights_collected_is_object CHECK (jsonb_typeof(collected_info) = 'object'),
  CONSTRAINT conversation_insights_summary_is_object CHECK (jsonb_typeof(summary) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_conversation_insights_account_label
  ON conversation_insights (account_id, lead_label_key);
CREATE INDEX IF NOT EXISTS idx_conversation_insights_contact
  ON conversation_insights (contact_id);

COMMENT ON TABLE conversation_insights IS
  'The assistant''s structured reading of a thread, rewritten on every '
  'inbound message. One row per conversation, which since migration 036 '
  'means one per contact — so this is also the commercial memory.';

ALTER TABLE conversation_insights ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS conversation_insights_select ON conversation_insights;
CREATE POLICY conversation_insights_select ON conversation_insights FOR SELECT
  USING (is_account_member(account_id));
-- Agents may correct what the assistant concluded (label, priority,
-- next action); the row itself is created by the service role.
DROP POLICY IF EXISTS conversation_insights_update ON conversation_insights;
CREATE POLICY conversation_insights_update ON conversation_insights FOR UPDATE
  USING (is_account_member(account_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS conversation_insights_insert ON conversation_insights;
CREATE POLICY conversation_insights_insert ON conversation_insights FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP TRIGGER IF EXISTS set_updated_at_conversation_insights ON conversation_insights;
CREATE TRIGGER set_updated_at_conversation_insights
  BEFORE UPDATE ON conversation_insights
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'conversation_insights'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE conversation_insights;
  END IF;
END $$;
