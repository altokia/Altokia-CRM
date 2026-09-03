/**
 * Leads — the deal seen from the conversation.
 *
 * A lead is not a second entity: it is the existing `deals` row, and
 * this module is the one place that opens or refreshes it from what the
 * assistant read (migration 043 columns). The rule for *when* a deal
 * appears on the board is deliberately generic: the contact showed real
 * interest (a commercial label), asked for a person, or produced work
 * for the team. Stages are never moved automatically — the sales
 * process stays a human decision; the assistant only fills in what it
 * learned.
 *
 * Every function is best-effort: a failure here is logged and never
 * blocks a reply.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { StructuredReply } from '@/lib/ai/structured'
import { PRIORITY_RANK } from '@/lib/tasks'
import type { TaskPriority } from '@/types'

/**
 * Built-in label keys (042) that mean "worth a card on the board".
 * Custom labels the business adds never open a lead on their own; the
 * `possible_lead` built-in is a maybe, so it does not either.
 */
export const OPENING_LABEL_KEYS: readonly string[] = ['interested', 'new_lead', 'pending_payment', 'paid']

export function shouldOpenLead(
  s: Pick<StructuredReply, 'leadLabel' | 'needsHuman' | 'actionType' | 'intentLevel'>,
): boolean {
  if (s.leadLabel && OPENING_LABEL_KEYS.includes(s.leadLabel)) return true
  if (s.needsHuman) return true
  if (s.actionType !== 'AI_CONTINUE') return true
  return s.intentLevel === 'high'
}

export interface SyncLeadArgs {
  accountId: string
  contactId: string
  conversationId: string
  structured: StructuredReply
  /** Owner for `deals.user_id` (NOT NULL) — the AI config's owner. */
  ownerUserId: string
  /** auth user currently holding the conversation, if any. */
  assignedUserId?: string | null
  /** A human-pinned label wins over the assistant's reading. */
  labelOverride?: string | null
}

export interface LeadSyncResult {
  dealId: string | null
  created: boolean
}

/**
 * Refresh the contact's open lead with the latest reading, or open one
 * when the reading warrants it. Priority only ever goes up from the
 * assistant's side — an advisor who lowered it keeps that decision until
 * the customer's tone changes.
 */
export async function syncLeadFromInsight(db: SupabaseClient, args: SyncLeadArgs): Promise<LeadSyncResult> {
  const { accountId, contactId, conversationId, structured: s } = args
  try {
    const existing = await openLead(db, accountId, contactId)
    const now = new Date().toISOString()
    const label = args.labelOverride ?? s.leadLabel

    const patch: Record<string, unknown> = {
      ai_summary: {
        text: s.summary,
        intent: s.intent,
        intent_level: s.intentLevel,
        need: s.need,
        next_action: s.nextAction,
        needs_human: s.needsHuman,
        updated_at: now,
      },
      last_interaction_at: now,
    }
    if (label) patch.label_key = label
    if (s.itemId) patch.item_id = s.itemId
    if (s.itemName) patch.item_name = s.itemName
    if (s.nextAction) patch.next_action = s.nextAction
    if (s.preferredContactTime) patch.preferred_contact_time = s.preferredContactTime

    if (existing) {
      const current = (existing.priority ?? 'normal') as TaskPriority
      if ((PRIORITY_RANK[s.priority] ?? 0) > (PRIORITY_RANK[current] ?? 0)) patch.priority = s.priority
      const { error } = await db.from('deals').update(patch).eq('id', existing.id)
      if (error) throw error
      return { dealId: existing.id, created: false }
    }

    if (!shouldOpenLead(s)) return { dealId: null, created: false }

    const home = await defaultStage(db, accountId)
    if (!home) return { dealId: null, created: false }

    const [contactRes, accountRes, item, assignedProfileId] = await Promise.all([
      db.from('contacts').select('name, phone').eq('id', contactId).maybeSingle(),
      db.from('accounts').select('default_currency').eq('id', accountId).maybeSingle(),
      s.itemId
        ? db
            .from('catalog_items')
            .select('price, currency')
            .eq('id', s.itemId)
            .maybeSingle()
            .then((r) => (r.data as { price: number | null; currency: string | null } | null) ?? null)
        : Promise.resolve(null),
      args.assignedUserId
        ? db
            .from('profiles')
            .select('id')
            .eq('user_id', args.assignedUserId)
            .eq('account_id', accountId)
            .maybeSingle()
            .then((r) => (r.data?.id as string | undefined) ?? null)
        : Promise.resolve(null),
    ])

    const contact = contactRes.data as { name: string | null; phone: string | null } | null
    const title = s.itemName?.trim() || contact?.name?.trim() || contact?.phone || 'Lead'

    const { data: inserted, error } = await db
      .from('deals')
      .insert({
        account_id: accountId,
        user_id: args.ownerUserId,
        pipeline_id: home.pipelineId,
        stage_id: home.stageId,
        contact_id: contactId,
        conversation_id: conversationId,
        title,
        value: item?.price ?? 0,
        currency: item?.currency ?? accountRes.data?.default_currency ?? 'USD',
        status: 'open',
        source: 'ai',
        priority: s.priority,
        assigned_to: assignedProfileId,
        ...patch,
      })
      .select('id')
      .single()
    if (error) throw error
    return { dealId: inserted.id as string, created: true }
  } catch (err) {
    console.warn('[leads] sync skipped:', err instanceof Error ? err.message : err)
    return { dealId: null, created: false }
  }
}

/**
 * Stamp a follow-up on the contact's open lead (the reminder typed from
 * the inbox or "Mi trabajo"). Returns the deal id, or null when the
 * contact has no open lead — the task still exists on its own.
 */
export async function setLeadFollowUp(
  db: SupabaseClient,
  args: { accountId: string; contactId: string; followUpAt: Date; nextAction?: string | null },
): Promise<string | null> {
  try {
    const existing = await openLead(db, args.accountId, args.contactId)
    if (!existing) return null
    const patch: Record<string, unknown> = { follow_up_at: args.followUpAt.toISOString() }
    if (args.nextAction) patch.next_action = args.nextAction
    const { error } = await db.from('deals').update(patch).eq('id', existing.id)
    if (error) throw error
    return existing.id
  } catch (err) {
    console.warn('[leads] follow-up skipped:', err instanceof Error ? err.message : err)
    return null
  }
}

// ---------------------------------------------------------------------

interface OpenLeadRow {
  id: string
  priority: TaskPriority | null
}

async function openLead(db: SupabaseClient, accountId: string, contactId: string): Promise<OpenLeadRow | null> {
  const { data, error } = await db
    .from('deals')
    .select('id, priority')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('status', 'open')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return (data as OpenLeadRow | null) ?? null
}

/**
 * Where a new lead lands: the account's first pipeline, its first stage
 * that is not a closing one. No pipeline yet → no automatic lead (the
 * board seeds itself the first time someone opens it).
 */
async function defaultStage(
  db: SupabaseClient,
  accountId: string,
): Promise<{ pipelineId: string; stageId: string } | null> {
  const { data: pipeline } = await db
    .from('pipelines')
    .select('id')
    .eq('account_id', accountId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!pipeline) return null
  const { data: stages } = await db
    .from('pipeline_stages')
    .select('id, is_won, is_lost')
    .eq('pipeline_id', pipeline.id)
    .order('position', { ascending: true })
  const rows = (stages ?? []) as { id: string; is_won: boolean | null; is_lost: boolean | null }[]
  const stage = rows.find((st) => !st.is_won && !st.is_lost) ?? rows[0]
  if (!stage) return null
  return { pipelineId: pipeline.id as string, stageId: stage.id }
}
