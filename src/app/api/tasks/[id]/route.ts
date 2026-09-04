import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { isTaskPriority, isTaskStatus } from '@/lib/tasks'
import type { TaskStatus } from '@/types'

/**
 * PATCH /api/tasks/[id]
 *
 * Body: { status?, priority?, due_at?, details?, title? }
 *
 * Edits the task itself — status, urgency, deadline, text. Who holds
 * it is a separate concern (…/assign, …/attend) because for HUMAN_CHAT
 * tasks the assignee lives on the conversation, not here.
 *
 * Timestamps follow the status: done/cancelled stamp `completed_at`,
 * in_progress stamps `started_at` (kept if already set — a task paused
 * and resumed started once), and reopening clears `completed_at`.
 */

const TASK_SELECT = '*, contact:contacts(id,name,phone,company)'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('agent')
    const { id } = await params

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const patch: Record<string, unknown> = {}

    if (body.status !== undefined) {
      if (!isTaskStatus(body.status)) {
        return NextResponse.json({ error: `Unknown status "${String(body.status)}"` }, { status: 400 })
      }
      patch.status = body.status
    }
    if (body.priority !== undefined) {
      if (!isTaskPriority(body.priority)) {
        return NextResponse.json(
          { error: `Unknown priority "${String(body.priority)}"` },
          { status: 400 },
        )
      }
      patch.priority = body.priority
    }
    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || !body.title.trim()) {
        return NextResponse.json({ error: 'Task title is required' }, { status: 400 })
      }
      patch.title = body.title.trim()
    }
    if (body.details !== undefined) {
      if (body.details !== null && typeof body.details !== 'string') {
        return NextResponse.json({ error: 'details must be a string or null' }, { status: 400 })
      }
      patch.details = body.details
    }
    if (body.due_at !== undefined) {
      // Moving the due date re-arms the reminder. sendDueReminders only
      // looks at rows with `due_notified_at IS NULL` (tasks/cron), so a
      // task that already fired once would otherwise be postponed into
      // permanent silence — the snooze would look like it worked and
      // then nothing would ever ring again.
      patch.due_notified_at = null
      if (body.due_at === null) {
        patch.due_at = null
      } else if (typeof body.due_at === 'string' && !Number.isNaN(Date.parse(body.due_at))) {
        patch.due_at = new Date(body.due_at).toISOString()
      } else {
        return NextResponse.json(
          { error: 'due_at must be an ISO 8601 date or null' },
          { status: 400 },
        )
      }
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }

    // Read first: a clean 404 for a foreign/missing id, and the existing
    // started_at so a resumed task keeps its original start.
    const { data: existing, error: readError } = await ctx.supabase
      .from('tasks')
      .select('id, status, started_at')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (readError) {
      console.error('[PATCH /api/tasks/[id]] fetch error:', readError)
      return NextResponse.json({ error: 'Failed to load task' }, { status: 500 })
    }
    if (!existing) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 })
    }

    if (patch.status !== undefined) {
      const now = new Date().toISOString()
      const status = patch.status as TaskStatus
      if (status === 'done' || status === 'cancelled') {
        patch.completed_at = now
      } else {
        patch.completed_at = null
        if (status === 'in_progress') patch.started_at = existing.started_at ?? now
      }
    }

    const { data: task, error } = await ctx.supabase
      .from('tasks')
      .update(patch)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select(TASK_SELECT)
      .single()
    if (error) {
      console.error('[PATCH /api/tasks/[id]] update error:', error)
      return NextResponse.json({ error: 'Failed to update task' }, { status: 500 })
    }

    return NextResponse.json({ task })
  } catch (err) {
    return toErrorResponse(err)
  }
}
