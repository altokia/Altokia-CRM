import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { transitionHandoff } from '@/lib/conversations/handoff'

/**
 * POST /api/conversations/[id]/assign
 *
 * Body: { assign_to: string | null }
 *
 * Assigns the thread to a teammate (auth.users.id) or clears the
 * assignee. Replaces the inbox's direct PostgREST update so that the
 * handoff state moves with the assignee: a thread handed to a person is
 * `human_active` (assistant silent); a thread nobody holds any more is
 * `waiting_for_human` — it still needs a person, the assistant does not
 * take it back on its own (that is the explicit Resume action).
 *
 * RLS remains the backstop: the update is scoped to the caller's account.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')
    const { id: conversationId } = await params

    let body: { assign_to?: unknown }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const assignTo = body.assign_to
    if (assignTo !== null && typeof assignTo !== 'string') {
      return NextResponse.json(
        { error: 'assign_to must be a user id or null' },
        { status: 400 },
      )
    }

    // Only members of this account may be assigned. A stranger's id
    // would otherwise pass the FK (any auth user) and leak nothing but
    // still be wrong.
    if (assignTo) {
      const { data: member } = await supabase
        .from('profiles')
        .select('user_id')
        .eq('account_id', accountId)
        .eq('user_id', assignTo)
        .maybeSingle()
      if (!member) {
        return NextResponse.json(
          { error: 'That user is not a member of this account' },
          { status: 400 },
        )
      }
    }

    const reason = assignTo
      ? assignTo === userId
        ? 'agent_took_over'
        : 'agent_assigned'
      : 'agent_unassigned'

    const result = await transitionHandoff(supabase, {
      conversationId,
      accountId,
      to: assignTo ? 'human_active' : 'waiting_for_human',
      reason,
      assignTo,
    })

    // The dropdown in the inbox is the way conversations actually get
    // assigned, and it was the one path that left no trace — so
    // "why did this land with me?" and "who took my lead?" had no
    // answer precisely where they are asked most. Every other assigner
    // (the tasks route, routing) already writes this row.
    const { error: auditError } = await supabase.from('assignment_events').insert({
      account_id: accountId,
      conversation_id: conversationId,
      assigned_to: assignTo,
      strategy: 'manual',
      decided_by: 'manual',
      reason,
      candidates: [],
    })
    if (auditError) {
      // The assignment already happened; losing its audit row must not
      // fail the request, but it should be loud in the logs.
      console.error('[conversations/assign] audit insert failed:', auditError.message)
    }

    return NextResponse.json({ ok: true, handoff_state: result.state })
  } catch (error) {
    return toErrorResponse(error)
  }
}
