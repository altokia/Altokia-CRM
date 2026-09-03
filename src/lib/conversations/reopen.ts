import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Re-open a closed conversation because the customer wrote again
 * (issue #409).
 *
 * Inbound processing bumps `unread_count` but used to leave `status`
 * alone, so a thread an agent closed — or that a `close_conversation`
 * automation step closed — stayed `closed` while accumulating unread
 * customer messages. It read as resolved, and it dropped out of the
 * inbox's Open filter, so an agent working that filter never saw the
 * reply. (Automation dispatch is unaffected either way: it keys on
 * account + trigger + contact, never conversation status.)
 *
 * Lives here rather than inline in the webhook so it can be tested
 * without standing up the whole route, and so any future inbound path
 * gets the same behaviour for free.
 */
export async function reopenClosedConversation(
  db: SupabaseClient,
  conversation: { id: string; status?: string | null },
): Promise<boolean> {
  // Nothing to do for open/pending threads, which is the common case —
  // skipping the round trip keeps inbound processing as cheap as it was.
  if (conversation.status !== 'closed') return false

  const now = new Date().toISOString()

  // Reopening also decides who owns the thread again (migration 040):
  // a thread that still has an assignee goes back to that person; an
  // unassigned one goes back to the assistant. Two guarded UPDATEs
  // rather than one — Supabase's builder cannot express a CASE — and
  // exactly one of them can match, so the row is touched once.
  //
  // Both keep the `status = 'closed'` guard, re-checked in SQL and not
  // just in the `if` above: the caller's row was read earlier in the
  // request, so two concurrent inbound deliveries both holding a stale
  // `status: 'closed'` must not be able to write 'open' back over an
  // agent who re-closed the thread in between.
  const assignedReopen = db
    .from('conversations')
    .update({
      status: 'open',
      handoff_state: 'human_active',
      handoff_reason: 'reopened_by_inbound',
      updated_at: now,
    })
    .eq('id', conversation.id)
    .eq('status', 'closed')
    .not('assigned_agent_id', 'is', null)
    .select('id')

  const unassignedReopen = db
    .from('conversations')
    .update({
      status: 'open',
      handoff_state: 'ai_active',
      handoff_reason: 'reopened_by_inbound',
      updated_at: now,
    })
    .eq('id', conversation.id)
    .eq('status', 'closed')
    .is('assigned_agent_id', null)
    .select('id')

  const [a, b] = await Promise.all([assignedReopen, unassignedReopen])
  const error = a.error ?? b.error

  if (error) {
    // Best-effort, same as the conversation update this follows: a failed
    // re-open must not abort inbound processing (and make Meta redeliver).
    console.error('Error re-opening conversation:', error)
    return false
  }

  return (a.data?.length ?? 0) + (b.data?.length ?? 0) > 0
}
