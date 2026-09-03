import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { transitionHandoff } from '@/lib/conversations/handoff'

type Params = { params: Promise<{ conversationId: string }> }

/**
 * POST /api/ai/autoreply/[conversationId]  (agent+)
 *
 * Toggle the AI auto-reply bot for one conversation from the inbox — the
 * "Take over" / "Resume AI" banner.
 *
 * Body: { paused: boolean, assign_to_me?: boolean }
 *   - paused: true  → pause the bot here (a human is taking over). When
 *                     `assign_to_me` is set, also assign the thread to the
 *                     caller (the usual "Take over" flow). Assignment
 *                     fires the `on_conversation_assigned` trigger.
 *   - paused: false → hand the thread back to the bot: clear the pause,
 *                     reset the per-conversation reply count so it gets
 *                     fresh slots, and clear the handoff note. If the
 *                     caller currently owns the thread, unassign it too so
 *                     the bot isn't blocked by the "human owns this" gate.
 *
 * Writes go through the RLS-scoped SSR client, so a conversation outside
 * the caller's account simply isn't found (404).
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    // Reuse the send bucket: this is a cheap per-user inbox action and
    // toggling it in a tight loop has no legitimate use.
    const limit = checkRateLimit(`ai-takeover:${userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const { conversationId } = await params
    const body = await request.json().catch(() => null)
    if (!body || typeof body.paused !== 'boolean') {
      return NextResponse.json(
        { error: 'paused (boolean) is required' },
        { status: 400 },
      )
    }
    const paused = body.paused as boolean
    const assignToMe = body.assign_to_me === true

    // Confirm the conversation is in the caller's account before writing.
    const { data: conv, error: convErr } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (convErr) {
      console.error('[ai/autoreply] conversation lookup error:', convErr)
      return NextResponse.json(
        { error: 'Failed to load conversation' },
        { status: 500 },
      )
    }
    if (!conv) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    // Both directions go through the single writer of handoff state
    // (migration 040).
    //
    // Pausing: "Take over" makes the thread human_active for the caller.
    // Pausing without taking it mutes the assistant and leaves ownership
    // where it was — human_active if someone already holds the thread,
    // otherwise waiting_for_human so the work queue can see it.
    //
    // Resuming hands the thread *back to the bot*: it releases ANY
    // assignment, not just the caller's own — the eligibility gate stands
    // down whenever a human is assigned, so a stale assignee would keep
    // the bot muted and make "Resume AI" a no-op — and gives the bot a
    // fresh reply budget. This is a deliberate, manual, rate-limited
    // action (not automatable), so it can't be used to bypass the
    // per-conversation cap at scale.
    let upErr: { message: string } | null = null
    try {
      if (paused) {
        let ownerAlready = false
        if (!assignToMe) {
          const { data: current } = await supabase
            .from('conversations')
            .select('assigned_agent_id')
            .eq('id', conversationId)
            .eq('account_id', accountId)
            .maybeSingle()
          ownerAlready = Boolean(current?.assigned_agent_id)
        }
        await transitionHandoff(supabase, {
          conversationId,
          accountId,
          to: assignToMe || ownerAlready ? 'human_active' : 'waiting_for_human',
          reason: assignToMe ? 'agent_took_over' : 'agent_paused',
          assignTo: assignToMe ? userId : undefined,
        })
      } else {
        await transitionHandoff(supabase, {
          conversationId,
          accountId,
          to: 'ai_active',
          reason: 'manual_resume',
        })
      }
    } catch (e) {
      upErr = { message: e instanceof Error ? e.message : String(e) }
    }
    if (upErr) {
      console.error('[ai/autoreply] update error:', upErr)
      return NextResponse.json(
        { error: 'Failed to update conversation' },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true, paused })
  } catch (err) {
    return toErrorResponse(err)
  }
}
