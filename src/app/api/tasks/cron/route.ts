import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { assignTask } from '@/lib/routing'
import type { AccountRouting, Task } from '@/types'

/**
 * GET /api/tasks/cron — the shift-start job.
 *
 * Every few minutes an external scheduler calls this with the same
 * `x-cron-secret` the automations cron uses. Two passes per account:
 *
 *   1. Retry routing for every task still waiting for a person. A lead
 *      that arrived at 13:00 for the 15:00-17:00 specialist sits here
 *      until the specialist's shift begins, then gets assigned (and the
 *      assignee notified by the 041 trigger). Same strategy and hints
 *      as the original attempt, so the outcome is what the first
 *      decision would have been had the person been on shift.
 *
 *   2. Due reminders: a task whose due_at has passed notifies its
 *      assignee once (`due_notified_at` guards the once).
 *
 * Bounded (50 tasks per pass per account) and best-effort, like the
 * other crons: a failure on one task is logged and the loop continues.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (suppliedBuf.length !== expectedBuf.length || !timingSafeEqual(suppliedBuf, expectedBuf)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const now = new Date()
  const nowIso = now.toISOString()

  const { data: accounts, error: accountsError } = await admin
    .from('accounts')
    .select('id, routing')
  if (accountsError) {
    return NextResponse.json({ error: accountsError.message }, { status: 500 })
  }

  let assigned = 0
  let retried = 0
  let reminded = 0

  for (const account of accounts ?? []) {
    const accountId = account.id as string
    const routing = ((account.routing as AccountRouting | null) ?? {}) as AccountRouting

    // ---- 1. Waiting work --------------------------------------------
    const { data: pending } = await admin
      .from('tasks')
      .select('id, conversation_id, action_type, routing, priority, created_at')
      .eq('account_id', accountId)
      .eq('status', 'pending')
      .is('assigned_to', null)
      .order('created_at', { ascending: true })
      .limit(50)

    for (const task of (pending ?? []) as Pick<Task, 'id' | 'conversation_id' | 'action_type' | 'routing'>[]) {
      retried++
      try {
        const result = await assignTask(admin, {
          accountId,
          task,
          strategy: routing.strategy,
          decidedBy: 'cron',
          reason: 'shift_start_review',
          now,
        })
        if (result.assignedTo) assigned++
      } catch (err) {
        console.error('[tasks/cron] routing failed for task', task.id, err instanceof Error ? err.message : err)
      }
    }

    // ---- 2. Due reminders --------------------------------------------
    const { data: due } = await admin
      .from('tasks')
      .select('id, assigned_to, conversation_id, contact_id, title, details, action_type, priority, due_at')
      .eq('account_id', accountId)
      .in('status', ['assigned', 'in_progress'])
      .not('assigned_to', 'is', null)
      .lte('due_at', nowIso)
      .is('due_notified_at', null)
      .limit(50)

    for (const task of due ?? []) {
      // Claim first so two overlapping runs cannot both notify.
      const { data: claimed } = await admin
        .from('tasks')
        .update({ due_notified_at: nowIso })
        .eq('id', task.id)
        .is('due_notified_at', null)
        .select('id')
        .maybeSingle()
      if (!claimed) continue

      const { error: notifyError } = await admin.from('notifications').insert({
        account_id: accountId,
        user_id: task.assigned_to,
        type: 'task_due',
        conversation_id: task.conversation_id,
        contact_id: task.contact_id,
        actor_user_id: null,
        title: task.title,
        body: task.details,
        metadata: {
          task_id: task.id,
          action_type: task.action_type,
          priority: task.priority,
          due_at: task.due_at,
        },
      })
      if (notifyError) {
        console.error('[tasks/cron] due notification failed for task', task.id, notifyError.message)
      } else {
        reminded++
      }
    }
  }

  return NextResponse.json({ retried, assigned, reminded })
}
