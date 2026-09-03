import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { transitionHandoff } from '@/lib/conversations/handoff'
import { assignConversation, assignTask } from '@/lib/routing'
import { OPEN_TASK_STATUSES } from '@/lib/tasks'
import type { Task, TaskRoutingHints } from '@/types'

/**
 * POST /api/tasks/[id]/assign
 *
 * Body: { assign_to: string | "me" | "auto" | null }
 *
 * Who holds this task. Two very different kinds of task hide behind
 * one endpoint:
 *
 *   * A HUMAN_CHAT task IS its conversation. Its assignee is
 *     `conversations.assigned_agent_id`, mirrored onto the task by the
 *     041 trigger, so the only correct way to (un)assign it is to move
 *     the conversation's handoff state — `transitionHandoff` for a
 *     person, `assignConversation` for "let routing decide". Writing
 *     `tasks.assigned_to` alone would leave the inbox and the queue
 *     disagreeing about who is on the thread.
 *   * Any other task (call, follow-up, quote…) is assigned on the row
 *     itself; "auto" goes through `assignTask`.
 *
 * Manual picks record an assignment_events row like routing does, so
 * a task's history reads the same regardless of who decided.
 */

const TASK_SELECT = '*, contact:contacts(id,name,phone,company)'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('agent')
    const { id: taskId } = await params

    const body = (await request.json().catch(() => null)) as { assign_to?: unknown } | null
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const target = body.assign_to === undefined ? null : body.assign_to
    if (target !== null && (typeof target !== 'string' || !target.trim())) {
      return NextResponse.json(
        { error: 'assign_to must be a user id, "me", "auto" or null' },
        { status: 400 },
      )
    }

    const { data, error: readError } = await ctx.supabase
      .from('tasks')
      .select('*')
      .eq('id', taskId)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (readError) {
      console.error('[POST /api/tasks/[id]/assign] fetch error:', readError)
      return NextResponse.json({ error: 'Failed to load task' }, { status: 500 })
    }
    const task = data as Task | null
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }
    if (!OPEN_TASK_STATUSES.includes(task.status)) {
      return NextResponse.json({ error: 'Task is already closed' }, { status: 400 })
    }

    // Resolve the concrete person, if any. "auto" stays a keyword.
    let assignee: string | null = null
    if (target === 'me') {
      assignee = ctx.userId
    } else if (target && target !== 'auto') {
      if (!(await isMember(ctx.supabase, ctx.accountId, target))) {
        return NextResponse.json(
          { error: 'That user is not a member of this account' },
          { status: 400 },
        )
      }
      assignee = target
    }

    const humanChat = task.action_type === 'HUMAN_CHAT' && !!task.conversation_id
    let assignedTo: string | null
    let nextAvailableAt: Date | null = null

    if (target === 'auto') {
      const result = humanChat
        ? await assignConversation(ctx.supabase, {
            accountId: ctx.accountId,
            conversationId: task.conversation_id as string,
            hints: (task.routing ?? {}) as TaskRoutingHints,
            decidedBy: 'routing',
            reason: 'agent_requested_routing',
          })
        : await assignTask(ctx.supabase, {
            accountId: ctx.accountId,
            task,
            decidedBy: 'routing',
            reason: 'agent_requested_routing',
          })
      assignedTo = result.assignedTo
      nextAvailableAt = result.nextAvailableAt
    } else {
      const now = new Date().toISOString()
      if (humanChat) {
        await transitionHandoff(ctx.supabase, {
          conversationId: task.conversation_id as string,
          accountId: ctx.accountId,
          to: assignee ? 'human_active' : 'waiting_for_human',
          assignTo: assignee,
          reason: assignee
            ? assignee === ctx.userId
              ? 'agent_took_over'
              : 'agent_assigned'
            : 'agent_unassigned',
        })
        // Back to the queue: the trigger only OPENS a task on
        // waiting_for_human; an existing in-progress one must be
        // released here so the queue shows it as nobody's again.
        if (!assignee) {
          const { error } = await ctx.supabase
            .from('tasks')
            .update({ assigned_to: null, status: 'pending', assigned_at: null })
            .eq('id', task.id)
            .eq('account_id', ctx.accountId)
          if (error) throw new Error(`[tasks/assign] release failed: ${error.message}`)
        }
      } else {
        const { error } = await ctx.supabase
          .from('tasks')
          .update(
            assignee
              ? { assigned_to: assignee, status: 'assigned', assigned_at: now }
              : { assigned_to: null, status: 'pending', assigned_at: null },
          )
          .eq('id', task.id)
          .eq('account_id', ctx.accountId)
        if (error) throw new Error(`[tasks/assign] update failed: ${error.message}`)
      }

      await ctx.supabase.from('assignment_events').insert({
        account_id: ctx.accountId,
        task_id: task.id,
        conversation_id: task.conversation_id,
        assigned_to: assignee,
        strategy: 'manual',
        decided_by: 'manual',
        reason: assignee ? (assignee === ctx.userId ? 'agent_took_over' : 'agent_assigned') : 'agent_unassigned',
        candidates: [],
      })
      assignedTo = assignee
    }

    const fresh = await reloadTask(ctx.supabase, ctx.accountId, task.id)
    return NextResponse.json({
      task: fresh ?? task,
      assigned_to: assignedTo,
      next_available_at: nextAvailableAt ? nextAvailableAt.toISOString() : null,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

async function isMember(db: SupabaseClient, accountId: string, userId: string): Promise<boolean> {
  const { data } = await db
    .from('profiles')
    .select('user_id')
    .eq('account_id', accountId)
    .eq('user_id', userId)
    .maybeSingle()
  return !!data
}

async function reloadTask(db: SupabaseClient, accountId: string, taskId: string): Promise<Task | null> {
  const { data } = await db
    .from('tasks')
    .select(TASK_SELECT)
    .eq('id', taskId)
    .eq('account_id', accountId)
    .maybeSingle()
  return (data as Task | null) ?? null
}
