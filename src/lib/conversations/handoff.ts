/**
 * The one place that changes who owns a conversation.
 *
 * Before this module, five different call sites wrote the columns that
 * together meant "the assistant is on / a human is on / nobody is on":
 * the inbox assignment dropdown, the take-over/resume route, the AI
 * handoff branch, the automations `assign_conversation` step and the
 * flows `handoff` node. Each set a slightly different subset, so
 * "waiting for a human" could not be told apart from "paused by an
 * agent", and an agent simply replying never stood the bot down.
 *
 * `transitionHandoff` is now the only writer of `handoff_state`, and it
 * keeps the legacy columns (`ai_autoreply_disabled`, `status`,
 * `assigned_agent_id`, `ai_handoff_summary`) consistent with it so every
 * existing reader keeps working unchanged.
 *
 * States (migration 040):
 *   ai_active         the assistant may reply
 *   waiting_for_human the assistant stood down; nobody has picked it up
 *   human_active      a teammate owns the thread; the assistant is silent
 *   closed
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export const HANDOFF_STATES = [
  'ai_active',
  'waiting_for_human',
  'human_active',
  'closed',
] as const
export type HandoffState = (typeof HANDOFF_STATES)[number]

export function isHandoffState(value: unknown): value is HandoffState {
  return (
    typeof value === 'string' &&
    (HANDOFF_STATES as readonly string[]).includes(value)
  )
}

/**
 * Why a transition happened. Free text in the database (no migration
 * per reason); these are the ones the app emits today.
 */
export type HandoffReason =
  | 'ai_requested'
  | 'ai_cap_reached'
  | 'flow_handoff'
  | 'flow_fallback'
  | 'automation_assign'
  | 'agent_replied'
  | 'agent_took_over'
  | 'agent_assigned'
  | 'agent_unassigned'
  | 'manual_resume'
  | 'closed_by_agent'
  | 'reopened_by_inbound'
  | (string & {})

export interface TransitionArgs {
  conversationId: string
  /**
   * Service-role callers must pass this so the write stays scoped to
   * the tenant; RLS-scoped clients are already confined by policy and
   * may omit it.
   */
  accountId?: string
  to: HandoffState
  reason?: HandoffReason
  /**
   * The teammate to hand the thread to (auth.users.id). Meaningful for
   * `human_active`. `null` explicitly clears the assignee.
   */
  assignTo?: string | null
  /**
   * With `assignTo`, only take the thread when nobody has it yet — the
   * "whoever replies first keeps it" rule. Without it, an existing
   * assignee is never overwritten by an automated path.
   */
  onlyIfUnassigned?: boolean
  /** Internal note for whoever picks the thread up. */
  summary?: string | null
}

export interface TransitionResult {
  state: HandoffState
  /** True when the assignee column was changed by this call. */
  assigned: boolean
}

interface ConversationPatch {
  handoff_state: HandoffState
  handoff_reason?: string | null
  waiting_since?: string | null
  ai_autoreply_disabled?: boolean
  ai_reply_count?: number
  ai_handoff_summary?: string | null
  assigned_agent_id?: string | null
  status?: 'open' | 'pending' | 'closed'
  updated_at: string
}

/**
 * Move a conversation to a new ownership state.
 *
 * Throws on a database error — callers on best-effort paths (the
 * webhook's post-processing, engines) wrap it; API routes let it
 * surface as a 500.
 */
export async function transitionHandoff(
  db: SupabaseClient,
  args: TransitionArgs,
): Promise<TransitionResult> {
  const now = new Date().toISOString()
  const patch: ConversationPatch = {
    handoff_state: args.to,
    handoff_reason: args.reason ?? null,
    updated_at: now,
  }
  let assigned = false

  switch (args.to) {
    case 'ai_active':
      // Handing the thread back to the assistant releases ANY assignee
      // and gives it a fresh reply budget. This is a deliberate human
      // action (the Resume button), not something engines do.
      patch.ai_autoreply_disabled = false
      patch.assigned_agent_id = null
      patch.ai_reply_count = 0
      patch.ai_handoff_summary = null
      patch.waiting_since = null
      break

    case 'waiting_for_human':
      patch.ai_autoreply_disabled = true
      patch.waiting_since = now
      // `pending` is what the inbox and the flows engine have always
      // used to mean "needs a person"; keep it in step.
      patch.status = 'pending'
      if (args.summary !== undefined) patch.ai_handoff_summary = args.summary
      if (args.assignTo === null) patch.assigned_agent_id = null
      break

    case 'human_active':
      patch.ai_autoreply_disabled = true
      patch.waiting_since = null
      if (args.summary !== undefined) patch.ai_handoff_summary = args.summary
      // Unconditional assignment goes in the same UPDATE; the
      // only-if-unassigned variant is a second, guarded UPDATE below so
      // the state change itself is never skipped.
      if (args.assignTo !== undefined && !args.onlyIfUnassigned) {
        patch.assigned_agent_id = args.assignTo
        assigned = true
      }
      break

    case 'closed':
      patch.status = 'closed'
      patch.waiting_since = null
      break
  }

  let query = db.from('conversations').update(patch).eq('id', args.conversationId)
  if (args.accountId) query = query.eq('account_id', args.accountId)
  const { error } = await query
  if (error) {
    throw new Error(`[handoff] transition to ${args.to} failed: ${error.message}`)
  }

  if (
    args.to === 'human_active' &&
    args.assignTo &&
    args.onlyIfUnassigned
  ) {
    let claim = db
      .from('conversations')
      .update({ assigned_agent_id: args.assignTo, updated_at: now })
      .eq('id', args.conversationId)
      .is('assigned_agent_id', null)
    if (args.accountId) claim = claim.eq('account_id', args.accountId)
    const { data, error: claimError } = await claim.select('id')
    if (claimError) {
      throw new Error(`[handoff] assignment claim failed: ${claimError.message}`)
    }
    assigned = (data?.length ?? 0) > 0
  }

  return { state: args.to, assigned }
}

/**
 * The gate every automated reply path checks: may the assistant speak
 * on this thread right now?
 */
export function assistantMayReply(state: HandoffState | null | undefined): boolean {
  return state === 'ai_active'
}
