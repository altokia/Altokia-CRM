import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext, buildMemory, loadBusinessProfile } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply, generateStructured } from './generate'
import { buildSystemPrompt } from './defaults'
import { buildHandoffSummary } from './handoff'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import { compilePersona } from './persona'
import { loadLeadLabels } from './labels'
import { parseStructuredReply, type StructuredReply } from './structured'
import { GET_ITEM_TOOL, SEARCH_ITEMS_TOOL, runCatalogTool } from './tools/catalog'
import { AiError } from './types'
import { engineSendText } from '@/lib/flows/meta-send'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { assistantMayReply, transitionHandoff } from '@/lib/conversations/handoff'
import { createTask } from '@/lib/tasks'
import { assignTask } from '@/lib/routing'
import { syncLeadFromInsight } from '@/lib/leads'
import type { SupabaseClient } from '@supabase/supabase-js'

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Since phase 2 the assistant works in structured mode: one model turn
 * that may look items up in the catalog (never inventing a price) and
 * ends with a structured reading of the conversation — reply, intent,
 * item of interest, need, priority, next action, whether a person is
 * needed, lead label, preferred contact time, summary. That reading is
 * persisted to conversation_insights (the commercial memory) and turned
 * into work: a HUMAN_CHAT handoff, or a CALL / APPOINTMENT / QUOTE /
 * FOLLOW_UP task routed to an advisor. Even when a person is needed the
 * assistant may still send a short reply (acknowledge, ask when to be
 * contacted) — the customer is never left hanging.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - the thread is not `ai_active` (a human owns it or it is waiting)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args

  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so if the account has any active one we stand down to
    // avoid double-texting the customer. (Relationship triggers like
    // `first_inbound_message` don't count — they're not per-message
    // auto-responders.)
    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1)
    if (autoResponders && autoResponders.length > 0) return

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count, handoff_state')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return
    // The explicit ownership state (migration 040) is the gate. The two
    // legacy checks stay as belt-and-braces for rows written by code that
    // predates it.
    if (!assistantMayReply(conv.handoff_state)) return
    if (conv.assigned_agent_id) return // a human owns this thread
    if (conv.ai_autoreply_disabled) return // handed off / turned off here
    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound).
    if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) return

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return

    // Per-account throttle: one runaway thread (or a burst from many)
    // must not spend the account's key faster than a human could read.
    const limit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!limit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`,
      )
      return
    }

    // Everything the model should know, gathered in parallel: retrieved
    // knowledge for this question, the always-on business facts, what we
    // remember about this contact, and the label vocabulary.
    const [knowledge, businessProfile, memory, labels] = await Promise.all([
      retrieveKnowledge(db, accountId, config, latestUserMessage(messages)),
      loadBusinessProfile(db, accountId),
      buildMemory(db, { accountId, conversationId, contactId }),
      loadLeadLabels(db, accountId),
    ])
    const labelKeys = labels.map((l) => l.key)
    const personaText = compilePersona(config.persona, {
      defaultLanguage: process.env.NEXT_PUBLIC_APP_LOCALE || 'es',
    })

    const structuredPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      personaText,
      businessProfile,
      memory,
      labels,
      structured: true,
    })

    let structured: StructuredReply
    let usage = null as Awaited<ReturnType<typeof generateStructured>>['usage']
    try {
      const result = await generateStructured({
        config,
        systemPrompt: structuredPrompt,
        messages,
        tools: [SEARCH_ITEMS_TOOL, GET_ITEM_TOOL],
        runTool: (call) => runCatalogTool(db, accountId, call.name, call.input),
        labelKeys,
      })
      structured = result.structured
      usage = result.usage
    } catch (err) {
      // A provider quirk with tools must never silence the assistant:
      // fall back to the legacy text turn (same persona and context),
      // reading the old handoff sentinel into the structured shape.
      if (!(err instanceof AiError)) throw err
      console.warn('[ai auto-reply] structured turn failed, falling back to text:', err.message)
      const legacyPrompt = buildSystemPrompt({
        userPrompt: config.systemPrompt,
        mode: 'auto_reply',
        knowledge,
        personaText,
        businessProfile,
        memory,
      })
      const legacy = await generateReply({ config, systemPrompt: legacyPrompt, messages })
      structured = parseStructuredReply(
        {
          reply: legacy.text,
          needs_human: legacy.handoff,
          action_type: legacy.handoff ? 'HUMAN_CHAT' : 'AI_CONTINUE',
          summary: '',
        },
        { labelKeys },
      )
      usage = legacy.usage
    }

    // Record token spend on the account's BYO key. Fire-and-forget so it
    // never adds latency to the customer-facing send: `logAiUsage`
    // swallows its own errors, so the floating promise can't reject.
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
    })

    // The commercial memory: what the assistant understood, kept per
    // conversation (= per contact). Best-effort, never blocks the reply.
    await persistInsight(db, { accountId, conversationId, contactId, structured })

    // The board: open the lead this reading implies, or refresh the one
    // already there. A human-pinned label (insight lock) is respected by
    // reading it back from the insight row persistInsight just wrote.
    const { data: pinned } = await db
      .from('conversation_insights')
      .select('lead_label_locked, lead_label_key')
      .eq('conversation_id', conversationId)
      .maybeSingle()
    await syncLeadFromInsight(db, {
      accountId,
      contactId,
      conversationId,
      structured,
      ownerUserId: configOwnerUserId,
      assignedUserId: conv.assigned_agent_id ?? null,
      labelOverride: pinned?.lead_label_locked ? (pinned.lead_label_key as string | null) : null,
    })

    const summaryText =
      structured.summary ||
      buildHandoffSummary({ messages, replyCount: conv.ai_reply_count ?? 0 })

    // Send the reply first (when there is one and a slot is free) so the
    // customer hears back even when a person is being lined up. The
    // atomic claim keeps the per-conversation cap exact under concurrent
    // inbounds: consume a slot slightly before the send lands — fail-safe:
    // under-reply rather than over-reply.
    if (structured.reply) {
      const { data: claimed, error: claimErr } = await db.rpc('claim_ai_reply_slot', {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      })
      if (claimErr) {
        // A real error here (vs. losing the cap race) is almost always a
        // deploy issue — e.g. `claim_ai_reply_slot` not EXECUTE-able by the
        // service role, or the migration not applied. Log it loudly: a
        // silent return makes "auto-reply never fires" undiagnosable.
        console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
      } else if (claimed === true) {
        await engineSendText({
          accountId,
          userId: configOwnerUserId,
          conversationId,
          contactId,
          text: structured.reply,
          aiGenerated: true,
        })
      }
    }

    if (!structured.needsHuman) return

    if (structured.actionType === 'HUMAN_CHAT' || !structured.reply) {
      // A person must take the chat itself. One transition through the
      // single writer of handoff state: a configured handoff agent takes
      // the thread (human_active); with none configured it goes to the
      // shared queue (waiting_for_human), where the 041 trigger opens the
      // HUMAN_CHAT task and the shift-start job can see it. Never stomps
      // an existing human assignment.
      if (config.handoffAgentId && !conv.assigned_agent_id) {
        await transitionHandoff(db, {
          conversationId,
          accountId,
          to: 'human_active',
          reason: 'ai_requested',
          assignTo: config.handoffAgentId,
          summary: summaryText,
        })
      } else {
        await transitionHandoff(db, {
          conversationId,
          accountId,
          to: 'waiting_for_human',
          reason: 'ai_requested',
          summary: summaryText,
        })
        await enrichHumanChatTask(db, { accountId, conversationId, structured })
      }
      return
    }

    // A call, appointment, quote, follow-up or review: the thread stays
    // with the assistant (it can keep answering and collecting details)
    // while the work item goes to the right person — or waits in the
    // queue for their shift, which is the whole point of phase 1.
    await createActionTask(db, { accountId, conversationId, contactId, structured, summaryText })
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}

// ---------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------

async function persistInsight(
  db: SupabaseClient,
  args: { accountId: string; conversationId: string; contactId: string; structured: StructuredReply },
): Promise<void> {
  const { accountId, conversationId, contactId, structured: s } = args
  try {
    // A human's label override wins until they change it again.
    const { data: existing } = await db
      .from('conversation_insights')
      .select('lead_label_locked, lead_label_key')
      .eq('conversation_id', conversationId)
      .maybeSingle()
    const keepLabel = existing?.lead_label_locked === true
    const now = new Date().toISOString()

    const { error } = await db.from('conversation_insights').upsert(
      {
        conversation_id: conversationId,
        account_id: accountId,
        contact_id: contactId,
        intent: s.intent,
        intent_level: s.intentLevel,
        item_id: s.itemId,
        item_name: s.itemName,
        need: s.need,
        priority: s.priority,
        preferences: s.preferences,
        collected_info: s.collectedInfo,
        next_action: s.nextAction,
        action_type: s.actionType,
        needs_human: s.needsHuman,
        lead_label_key: keepLabel ? (existing?.lead_label_key ?? null) : s.leadLabel,
        preferred_contact_time: s.preferredContactTime,
        summary: {
          text: s.summary,
          interest: s.itemName,
          intent_level: s.intentLevel,
          contact_preference: s.preferredContactTime,
          needs_human: s.needsHuman,
          next_action: s.nextAction,
        },
        last_extracted_at: now,
      },
      { onConflict: 'conversation_id' },
    )
    if (error) console.warn('[ai auto-reply] insight upsert failed:', error.message)
  } catch (err) {
    console.warn('[ai auto-reply] insight persist threw:', err instanceof Error ? err.message : err)
  }
}

/**
 * The 041 trigger opened a bare HUMAN_CHAT task; give it what the
 * assistant learned so the queue card is useful and routing can match
 * the right person.
 */
async function enrichHumanChatTask(
  db: SupabaseClient,
  args: { accountId: string; conversationId: string; structured: StructuredReply },
): Promise<void> {
  const { accountId, conversationId, structured: s } = args
  try {
    await db
      .from('tasks')
      .update({
        priority: s.priority,
        details: s.summary || null,
        routing: s.itemId ? { item_id: s.itemId } : {},
        summary: {
          text: s.summary,
          interest: s.itemName,
          need: s.need,
          contact_preference: s.preferredContactTime,
          intent_level: s.intentLevel,
          lead_label: s.leadLabel,
        },
      })
      .eq('account_id', accountId)
      .eq('conversation_id', conversationId)
      .eq('action_type', 'HUMAN_CHAT')
      .in('status', ['pending', 'assigned'])
  } catch (err) {
    console.warn('[ai auto-reply] task enrich failed:', err instanceof Error ? err.message : err)
  }
}

async function createActionTask(
  db: SupabaseClient,
  args: {
    accountId: string
    conversationId: string
    contactId: string
    structured: StructuredReply
    summaryText: string
  },
): Promise<void> {
  const { accountId, conversationId, contactId, structured: s, summaryText } = args
  try {
    // One open task of this kind per conversation: a customer repeating
    // "call me" must not fan out into five calls.
    const { data: open } = await db
      .from('tasks')
      .select('id')
      .eq('account_id', accountId)
      .eq('conversation_id', conversationId)
      .eq('action_type', s.actionType)
      .in('status', ['pending', 'assigned', 'in_progress'])
      .limit(1)
    if (open && open.length) return

    const { data: contact } = await db
      .from('contacts')
      .select('name, phone')
      .eq('id', contactId)
      .maybeSingle()
    const who = contact?.name || contact?.phone || 'Cliente'

    const task = await createTask(db, {
      accountId,
      actionType: s.actionType,
      title: `${who}${s.itemName ? ` · ${s.itemName}` : ''}`,
      details: [summaryText, s.preferredContactTime ? `Prefiere contacto: ${s.preferredContactTime}` : null]
        .filter(Boolean)
        .join('\n'),
      priority: s.priority,
      conversationId,
      contactId,
      source: 'ai',
      routing: s.itemId ? { item_id: s.itemId } : {},
      summary: {
        text: s.summary,
        interest: s.itemName,
        need: s.need,
        contact_preference: s.preferredContactTime,
        intent_level: s.intentLevel,
        lead_label: s.leadLabel,
        next_action: s.nextAction,
      },
    })

    // Route it now; if nobody suitable is on shift it stays pending and
    // the shift-start cron picks it up.
    await assignTask(db, { accountId, task, decidedBy: 'ai', reason: 'ai_requested_action' })
  } catch (err) {
    console.warn('[ai auto-reply] action task failed:', err instanceof Error ? err.message : err)
  }
}
