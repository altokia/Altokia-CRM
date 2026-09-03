import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { transitionHandoff } from '@/lib/conversations/handoff'
import { OPEN_TASK_STATUSES } from '@/lib/tasks'
import type { Task } from '@/types'

/**
 * POST /api/tasks/[id]/attend — the "Atender" button.
 *
 * One click = "this is mine and I am on it now": assignee = caller,
 * status = in_progress. For a HUMAN_CHAT task that means taking the
 * conversation (`human_active`, assistant silent); the 041 trigger then
 * marks the task in progress for us, so the row is never written
 * directly — same rule as …/assign.
 *
 * Returns the conversation id so the client can jump straight to the
 * thread.
 */

const TASK_SELECT = '*, contact:contacts(id,name,phone,company)'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('agent')
    const { id: taskId } = await params

    const { data, error: readError } = await ctx.supabase
      .from('tasks')
      .select('*')
      .eq('id', taskId)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (readError) {
      console.error('[POST /api/tasks/[id]/attend] fetch error:', readError)
      return NextResponse.json({ error: 'Failed to load task' }, { status: 500 })
    }
    const task = data as Task | null
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }
    if (!OPEN_TASK_STATUSES.includes(task.status)) {
      return NextResponse.json({ error: 'Task is already closed' }, { status: 400 })
    }

    const now = new Date().toISOString()
    if (task.action_type === 'HUMAN_CHAT' && task.conversation_id) {
      await transitionHandoff(ctx.supabase, {
        conversationId: task.conversation_id,
        accountId: ctx.accountId,
        to: 'human_active',
        assignTo: ctx.userId,
        reason: 'agent_took_over',
      })
    } else {
      const { error } = await ctx.supabase
        .from('tasks')
        .update({
          assigned_to: ctx.userId,
          status: 'in_progress',
          // Taking over someone else's task restarts the assignment
          // clock; picking up my own keeps the original stamps.
          assigned_at: task.assigned_to === ctx.userId && task.assigned_at ? task.assigned_at : now,
          started_at: task.started_at ?? now,
        })
        .eq('id', task.id)
        .eq('account_id', ctx.accountId)
      if (error) throw new Error(`[tasks/attend] update failed: ${error.message}`)
    }

    await ctx.supabase.from('assignment_events').insert({
      account_id: ctx.accountId,
      task_id: task.id,
      conversation_id: task.conversation_id,
      assigned_to: ctx.userId,
      strategy: 'manual',
      decided_by: 'manual',
      reason: 'agent_took_over',
      candidates: [],
    })

    const { data: fresh } = await ctx.supabase
      .from('tasks')
      .select(TASK_SELECT)
      .eq('id', task.id)
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    return NextResponse.json({
      task: (fresh as Task | null) ?? task,
      conversation_id: task.conversation_id,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
