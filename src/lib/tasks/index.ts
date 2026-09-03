/**
 * Tasks — the work queue's vocabulary and the few helpers every writer
 * shares. The table is generic (migration 041); this module is where
 * "what counts as a valid task" lives so the DB needs no CHECK on
 * action_type and a new kind of action is a constant here.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  TASK_ACTION_TYPES,
  type Task,
  type TaskActionType,
  type TaskPriority,
  type TaskRoutingHints,
  type TaskSource,
  type TaskStatus,
} from '@/types'

export const TASK_PRIORITIES: readonly TaskPriority[] = ['low', 'normal', 'high', 'urgent']
export const OPEN_TASK_STATUSES: readonly TaskStatus[] = ['pending', 'assigned', 'in_progress']

/** Higher sorts first. */
export const PRIORITY_RANK: Record<TaskPriority, number> = {
  urgent: 4,
  high: 3,
  normal: 2,
  low: 1,
}

/**
 * Built-in types plus anything the business added through its own
 * constants. Free text is accepted when it looks like a type
 * (UPPER_SNAKE, 3-40 chars) so a typo does not silently become a new
 * category.
 */
export function isTaskActionType(value: unknown): value is TaskActionType {
  if (typeof value !== 'string') return false
  if ((TASK_ACTION_TYPES as readonly string[]).includes(value)) return true
  return /^[A-Z][A-Z0-9_]{2,39}$/.test(value)
}

export function isTaskPriority(value: unknown): value is TaskPriority {
  return typeof value === 'string' && (TASK_PRIORITIES as readonly string[]).includes(value)
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return (
    typeof value === 'string' &&
    ['pending', 'assigned', 'in_progress', 'done', 'cancelled'].includes(value)
  )
}

export interface CreateTaskInput {
  accountId: string
  actionType: TaskActionType
  title: string
  details?: string | null
  priority?: TaskPriority
  conversationId?: string | null
  contactId?: string | null
  dealId?: string | null
  assignedTo?: string | null
  createdBy?: string | null
  source?: TaskSource
  dueAt?: string | Date | null
  preferredWindow?: { after?: string; before?: string } | null
  routing?: TaskRoutingHints
  summary?: Record<string, unknown>
}

/** Insert a task. Throws on a database error; validation errors carry a `code`. */
export async function createTask(db: SupabaseClient, input: CreateTaskInput): Promise<Task> {
  if (!isTaskActionType(input.actionType)) {
    throw new TaskValidationError(`Unknown action type "${String(input.actionType)}"`)
  }
  const title = input.title?.trim()
  if (!title) throw new TaskValidationError('Task title is required')
  if (input.priority !== undefined && !isTaskPriority(input.priority)) {
    throw new TaskValidationError(`Unknown priority "${String(input.priority)}"`)
  }

  const row = {
    account_id: input.accountId,
    action_type: input.actionType,
    title,
    details: input.details ?? null,
    priority: input.priority ?? 'normal',
    conversation_id: input.conversationId ?? null,
    contact_id: input.contactId ?? null,
    deal_id: input.dealId ?? null,
    assigned_to: input.assignedTo ?? null,
    status: input.assignedTo ? 'assigned' : 'pending',
    assigned_at: input.assignedTo ? new Date().toISOString() : null,
    created_by: input.createdBy ?? null,
    source: input.source ?? 'manual',
    due_at: input.dueAt ? new Date(input.dueAt).toISOString() : null,
    preferred_window: input.preferredWindow ?? null,
    routing: input.routing ?? {},
    summary: input.summary ?? {},
  }

  const { data, error } = await db.from('tasks').insert(row).select('*').single()
  if (error) throw new Error(`[tasks] create failed: ${error.message}`)
  return data as Task
}

export class TaskValidationError extends Error {
  readonly code = 'bad_request'
  constructor(message: string) {
    super(message)
    this.name = 'TaskValidationError'
  }
}

/**
 * Sort for the queue: priority, then age (oldest first), then due date.
 * Pure so the page and the cron sort identically.
 */
export function compareTasks(a: Task, b: Task): number {
  const p = PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority]
  if (p !== 0) return p
  const da = a.due_at ? Date.parse(a.due_at) : Number.POSITIVE_INFINITY
  const dbb = b.due_at ? Date.parse(b.due_at) : Number.POSITIVE_INFINITY
  if (da !== dbb) return da - dbb
  return Date.parse(a.created_at) - Date.parse(b.created_at)
}
