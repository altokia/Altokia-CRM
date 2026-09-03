import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { parseHHMM } from '@/lib/availability'
import { transitionHandoff } from '@/lib/conversations/handoff'
import { assignTask } from '@/lib/routing'
import {
  compareTasks,
  createTask,
  isTaskActionType,
  isTaskPriority,
  TaskValidationError,
  type CreateTaskInput,
} from '@/lib/tasks'
import type { Task, TaskRoutingHints } from '@/types'

/**
 * /api/tasks — the work queue.
 *
 *   GET  ?scope=mine|queue&action_type=…   any member
 *   POST { action_type, title, … assign_to } agent+
 *
 * The queue card joins the contact so the list renders without a
 * second round trip. Sorting is done in memory with `compareTasks` so
 * the page, the cron and the queue all agree on "most urgent first".
 */

const TASK_SELECT = '*, contact:contacts(id,name,phone,company)'
const LIST_LIMIT = 200

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const url = new URL(request.url)
    const scope = url.searchParams.get('scope') ?? 'queue'
    const actionType = url.searchParams.get('action_type')

    if (scope !== 'mine' && scope !== 'queue') {
      return NextResponse.json({ error: 'scope must be "mine" or "queue"' }, { status: 400 })
    }
    if (actionType !== null && !isTaskActionType(actionType)) {
      return NextResponse.json({ error: `Unknown action type "${actionType}"` }, { status: 400 })
    }

    let query = ctx.supabase.from('tasks').select(TASK_SELECT).eq('account_id', ctx.accountId)
    if (scope === 'mine') {
      // "My work": what I hold and have not finished. Pending tasks are
      // nobody's yet, so they belong to the queue even if I created them.
      query = query.eq('assigned_to', ctx.userId).in('status', ['assigned', 'in_progress'])
    } else {
      query = query.eq('status', 'pending')
    }
    if (actionType) query = query.eq('action_type', actionType)

    // Oldest first in the DB so the 200 cap drops the newest, not the
    // work that has been waiting longest; priority ordering happens below.
    const { data, error } = await query.order('created_at', { ascending: true }).limit(LIST_LIMIT)
    if (error) {
      console.error('[GET /api/tasks] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load tasks' }, { status: 500 })
    }

    const tasks = ((data ?? []) as Task[]).sort(compareTasks)
    return NextResponse.json({ tasks })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent')

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    let input: Omit<CreateTaskInput, 'accountId'>
    let target: AssignTarget
    try {
      input = parseCreateBody(body)
      target = parseAssignTarget(body.assign_to)
    } catch (err) {
      if (err instanceof TaskValidationError) {
        return NextResponse.json({ error: err.message }, { status: 400 })
      }
      throw err
    }

    // A concrete assignee must be a member of this account. The FK
    // alone would accept any auth user.
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

    // A HUMAN_CHAT task is really its conversation: the 041 trigger
    // mirrors the conversation's assignee onto the task, so the row is
    // never assigned on its own — the handoff below does it.
    const humanChat = input.actionType === 'HUMAN_CHAT' && !!input.conversationId

    let task: Task
    try {
      task = await createTask(ctx.supabase, {
        ...input,
        accountId: ctx.accountId,
        createdBy: ctx.userId,
        source: 'manual',
        assignedTo: humanChat ? null : assignee,
      })
    } catch (err) {
      if (err instanceof TaskValidationError) {
        return NextResponse.json({ error: err.message }, { status: 400 })
      }
      throw err
    }

    let assignedTo: string | null = task.assigned_to
    let nextAvailableAt: Date | null = null

    if (target === 'auto') {
      const result = await assignTask(ctx.supabase, {
        accountId: ctx.accountId,
        task,
        decidedBy: 'routing',
        reason: 'created:auto',
      })
      assignedTo = result.assignedTo
      nextAvailableAt = result.nextAvailableAt
    } else if (assignee) {
      if (humanChat) {
        await transitionHandoff(ctx.supabase, {
          conversationId: task.conversation_id as string,
          accountId: ctx.accountId,
          to: 'human_active',
          assignTo: assignee,
          reason: assignee === ctx.userId ? 'agent_took_over' : 'agent_assigned',
        })
      }
      assignedTo = assignee
      // Manual picks leave the same audit trail routing does, so the
      // history of a task reads the same whoever decided.
      await ctx.supabase.from('assignment_events').insert({
        account_id: ctx.accountId,
        task_id: task.id,
        conversation_id: task.conversation_id,
        assigned_to: assignee,
        strategy: 'manual',
        decided_by: 'manual',
        reason: 'created:direct',
        candidates: [],
      })
    }

    // Re-read so the response reflects what routing / the trigger did.
    const fresh = await reloadTask(ctx.supabase, ctx.accountId, task.id)
    return NextResponse.json(
      {
        task: fresh ?? task,
        assigned_to: assignedTo,
        next_available_at: nextAvailableAt ? nextAvailableAt.toISOString() : null,
      },
      { status: 201 },
    )
  } catch (err) {
    return toErrorResponse(err)
  }
}

// ---------------------------------------------------------------------
// Body parsing — every failure is a TaskValidationError so the handler
// maps them all to one 400 branch.
// ---------------------------------------------------------------------

type AssignTarget = string | null

function parseAssignTarget(value: unknown): AssignTarget {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' && value.trim()) return value
  throw new TaskValidationError('assign_to must be a user id, "me", "auto" or null')
}

function parseCreateBody(body: Record<string, unknown>): Omit<CreateTaskInput, 'accountId'> {
  if (!isTaskActionType(body.action_type)) {
    throw new TaskValidationError(`Unknown action type "${String(body.action_type)}"`)
  }
  if (typeof body.title !== 'string' || !body.title.trim()) {
    throw new TaskValidationError('Task title is required')
  }
  if (body.priority !== undefined && !isTaskPriority(body.priority)) {
    throw new TaskValidationError(`Unknown priority "${String(body.priority)}"`)
  }

  return {
    actionType: body.action_type,
    title: body.title.trim(),
    details: optionalString(body.details, 'details'),
    priority: body.priority,
    contactId: optionalString(body.contact_id, 'contact_id'),
    conversationId: optionalString(body.conversation_id, 'conversation_id'),
    dealId: optionalString(body.deal_id, 'deal_id'),
    dueAt: parseDueAt(body.due_at),
    preferredWindow: parsePreferredWindow(body.preferred_window),
    routing: parseRoutingHints(body.routing),
  }
}

function optionalString(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value === 'string') return value
  throw new TaskValidationError(`${field} must be a string or null`)
}

function parseDueAt(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value
  throw new TaskValidationError('due_at must be an ISO 8601 date or null')
}

function parsePreferredWindow(value: unknown): CreateTaskInput['preferredWindow'] {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TaskValidationError('preferred_window must be an object')
  }
  const raw = value as Record<string, unknown>
  const window: { after?: string; before?: string } = {}
  for (const key of ['after', 'before'] as const) {
    if (raw[key] === undefined || raw[key] === null) continue
    if (typeof raw[key] !== 'string') {
      throw new TaskValidationError(`preferred_window.${key} must be HH:mm`)
    }
    try {
      parseHHMM(raw[key] as string)
    } catch {
      throw new TaskValidationError(`preferred_window.${key} must be HH:mm`)
    }
    window[key] = raw[key] as string
  }
  return window
}

function parseRoutingHints(value: unknown): TaskRoutingHints | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TaskValidationError('routing must be an object')
  }
  const raw = value as Record<string, unknown>
  const hints: TaskRoutingHints = {}
  for (const key of ['department', 'item_id', 'previous_advisor_id'] as const) {
    if (raw[key] === undefined || raw[key] === null) continue
    if (typeof raw[key] !== 'string') throw new TaskValidationError(`routing.${key} must be a string`)
    hints[key] = raw[key] as string
  }
  if (raw.specialties !== undefined && raw.specialties !== null) {
    if (!Array.isArray(raw.specialties) || !raw.specialties.every((s) => typeof s === 'string')) {
      throw new TaskValidationError('routing.specialties must be an array of strings')
    }
    hints.specialties = raw.specialties as string[]
  }
  return hints
}

// ---------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------

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
