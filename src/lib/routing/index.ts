/**
 * Routing — who gets this conversation or task?
 *
 * The single place every assignment decision is made, replacing the
 * five call sites that used to write assignees on their own (inbox,
 * take-over route, AI handoff, automation step, flow node). All of them
 * now go through `assignConversation` / `assignTask`, so the strategies
 * below are the only strategies, and every decision leaves an
 * `assignment_events` row saying who was considered and why.
 *
 * The decision is made here, in the backend, from data — never by the
 * language model. Availability comes from lib/availability.
 *
 * When nobody suitable is available, the answer is "nobody", on
 * purpose: the lead goes to the queue as a task with its routing hints,
 * and the shift-start job (api/tasks/cron) retries when the right
 * person's shift begins. That is the 13:00 → 15:00 scenario.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  computeAvailability,
  nextShiftStart,
  type AdvisorSnapshot,
  type Availability,
  type ScheduleWindow,
  type Weekday,
} from '@/lib/availability'
import { transitionHandoff } from '@/lib/conversations/handoff'
import type { AccountRouting, RoutingStrategy, Task, TaskRoutingHints } from '@/types'

export interface Candidate {
  userId: string
  fullName: string
  department: string | null
  specialties: string[]
  itemIds: string[]
  snapshot: AdvisorSnapshot
  availability: Availability
  nextShiftStart: Date | null
}

export interface ConsideredEntry {
  user_id: string
  available: boolean
  reasons: Availability['reasons']
  load: number
}

export interface Decision {
  chosen: Candidate | null
  strategy: RoutingStrategy
  considered: ConsideredEntry[]
}

export const DEFAULT_STRATEGY: RoutingStrategy = 'by_schedule'

// ---------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------

export interface RoutingContext {
  timezone: string
  routing: AccountRouting
  candidates: Candidate[]
}

/**
 * Everything the picker needs, in four account-scoped reads. Works with
 * either an RLS-scoped client (routes) or the service-role client
 * (engines, cron).
 */
export async function loadRoutingContext(
  db: SupabaseClient,
  accountId: string,
  now: Date = new Date(),
): Promise<RoutingContext> {
  const [{ data: account }, { data: members }, { data: advisors }, { data: schedules }, { data: presence }, { data: owned }, { data: busyTasks }] =
    await Promise.all([
      db.from('accounts').select('timezone, routing').eq('id', accountId).maybeSingle(),
      db
        .from('profiles')
        .select('user_id, full_name, account_role')
        .eq('account_id', accountId)
        .in('account_role', ['owner', 'admin', 'agent']),
      db.from('advisor_profiles').select('*').eq('account_id', accountId),
      db.from('advisor_schedules').select('user_id, weekday, start_time, end_time').eq('account_id', accountId),
      db.from('member_presence').select('user_id, last_seen_at').eq('account_id', accountId),
      db
        .from('conversations')
        .select('assigned_agent_id')
        .eq('account_id', accountId)
        .eq('handoff_state', 'human_active')
        .not('assigned_agent_id', 'is', null),
      db
        .from('tasks')
        .select('assigned_to')
        .eq('account_id', accountId)
        .eq('status', 'in_progress')
        .neq('action_type', 'HUMAN_CHAT')
        .not('assigned_to', 'is', null),
    ])

  const timezone = (account?.timezone as string | undefined) || 'UTC'
  const routing = ((account?.routing as AccountRouting | null) ?? {}) as AccountRouting

  const load = new Map<string, number>()
  for (const r of owned ?? []) bump(load, r.assigned_agent_id as string)
  for (const r of busyTasks ?? []) bump(load, r.assigned_to as string)

  const advisorByUser = new Map((advisors ?? []).map((a) => [a.user_id as string, a]))
  const presenceByUser = new Map((presence ?? []).map((p) => [p.user_id as string, p.last_seen_at as string]))
  const schedulesByUser = new Map<string, ScheduleWindow[]>()
  for (const s of schedules ?? []) {
    const list = schedulesByUser.get(s.user_id as string) ?? []
    list.push({
      weekday: s.weekday as Weekday,
      start: hhmm(s.start_time as string),
      end: hhmm(s.end_time as string),
    })
    schedulesByUser.set(s.user_id as string, list)
  }

  const candidates: Candidate[] = (members ?? []).map((m) => {
    const userId = m.user_id as string
    const adv = advisorByUser.get(userId)
    const lastSeen = presenceByUser.get(userId)
    const snapshot: AdvisorSnapshot = {
      userId,
      schedules: schedulesByUser.get(userId) ?? [],
      presenceAgeMinutes: lastSeen ? Math.max(0, (now.getTime() - Date.parse(lastSeen)) / 60_000) : null,
      load: load.get(userId) ?? 0,
      capacity: (adv?.capacity as number | undefined) ?? 10,
      override: (adv?.availability_override as AdvisorSnapshot['override']) ?? null,
      acceptsAssignments: (adv?.accepts_assignments as boolean | undefined) ?? true,
    }
    return {
      userId,
      fullName: (m.full_name as string) ?? '',
      department: (adv?.department as string | null) ?? null,
      specialties: (adv?.specialties as string[] | undefined) ?? [],
      itemIds: (adv?.item_ids as string[] | undefined) ?? [],
      snapshot,
      availability: computeAvailability(snapshot, now, timezone),
      nextShiftStart: nextShiftStart(snapshot.schedules, now, timezone),
    }
  })

  return { timezone, routing, candidates }
}

function bump(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1)
}

/** Postgres TIME comes back as 'HH:mm:ss'; the availability lib wants 'HH:mm'. */
function hhmm(t: string): string {
  return t.slice(0, 5)
}

// ---------------------------------------------------------------------
// The decision (pure)
// ---------------------------------------------------------------------

export function pickAssignee(
  candidates: Candidate[],
  opts: { strategy?: RoutingStrategy; hints?: TaskRoutingHints; routing?: AccountRouting },
): Decision {
  const strategy = opts.strategy ?? opts.routing?.strategy ?? DEFAULT_STRATEGY
  const hints = opts.hints ?? {}
  const considered: ConsideredEntry[] = candidates.map((c) => ({
    user_id: c.userId,
    available: c.availability.available,
    reasons: c.availability.reasons,
    load: c.snapshot.load,
  }))
  const available = candidates.filter((c) => c.availability.available)
  const byLoad = (list: Candidate[]) =>
    [...list].sort(
      (a, b) => a.snapshot.load - b.snapshot.load || a.fullName.localeCompare(b.fullName),
    )

  let chosen: Candidate | null = null

  switch (strategy) {
    case 'manual':
      chosen = null
      break

    case 'previous_advisor': {
      const prev = hints.previous_advisor_id
      chosen = (prev && available.find((c) => c.userId === prev)) || byLoad(available)[0] || null
      break
    }

    // A filter with no available match yields NOBODY, not "anyone":
    // that is exactly the "specialist is off shift, wait for them"
    // behaviour the queue exists for.
    case 'by_department':
      chosen = byLoad(
        hints.department ? available.filter((c) => c.department === hints.department) : available,
      )[0] ?? null
      break

    case 'by_specialty': {
      const wanted = hints.specialties ?? []
      chosen = byLoad(
        wanted.length ? available.filter((c) => c.specialties.some((s) => wanted.includes(s))) : available,
      )[0] ?? null
      break
    }

    case 'by_item':
      chosen = byLoad(
        hints.item_id ? available.filter((c) => c.itemIds.includes(hints.item_id!)) : available,
      )[0] ?? null
      break

    case 'round_robin': {
      const ring = [...available].sort((a, b) => a.userId.localeCompare(b.userId))
      if (ring.length) {
        const last = opts.routing?.last_assigned_user_id
        const idx = last ? ring.findIndex((c) => c.userId > last) : 0
        chosen = ring[idx === -1 ? 0 : idx]
      }
      break
    }

    case 'least_load':
    case 'by_schedule':
    case 'priority':
    default: {
      // Honour whichever hints are present, then least load.
      let pool = available
      if (hints.department) pool = pool.filter((c) => c.department === hints.department)
      if (hints.specialties?.length) {
        pool = pool.filter((c) => c.specialties.some((s) => hints.specialties!.includes(s)))
      }
      if (hints.item_id) pool = pool.filter((c) => c.itemIds.includes(hints.item_id!))
      // Hints narrowed to nobody → keep waiting for the right person.
      chosen = byLoad(pool)[0] ?? null
      break
    }
  }

  return { chosen, strategy, considered }
}

// ---------------------------------------------------------------------
// Side-effecting entry points
// ---------------------------------------------------------------------

export interface AssignConversationArgs {
  accountId: string
  conversationId: string
  strategy?: RoutingStrategy
  hints?: TaskRoutingHints
  decidedBy: 'routing' | 'manual' | 'ai' | 'automation' | 'flow' | 'cron'
  reason?: string
  /** Note for whoever picks the thread up (stored as the handoff summary). */
  summary?: string | null
  now?: Date
}

export interface AssignResult {
  assignedTo: string | null
  decision: Decision
  /** When nobody was available: the earliest next shift among suitable advisors, if any. */
  nextAvailableAt: Date | null
}

/**
 * Route a conversation. On success the thread becomes `human_active`
 * for the chosen advisor; otherwise it becomes `waiting_for_human` (the
 * 041 trigger opens the HUMAN_CHAT task) and the hints are stored on
 * that task so the cron can retry with the same criteria.
 */
export async function assignConversation(
  db: SupabaseClient,
  args: AssignConversationArgs,
): Promise<AssignResult> {
  const now = args.now ?? new Date()
  const ctx = await loadRoutingContext(db, args.accountId, now)
  const decision = pickAssignee(ctx.candidates, {
    strategy: args.strategy,
    hints: args.hints,
    routing: ctx.routing,
  })

  if (decision.chosen) {
    await transitionHandoff(db, {
      conversationId: args.conversationId,
      accountId: args.accountId,
      to: 'human_active',
      reason: args.reason ?? `${args.decidedBy}:${decision.strategy}`,
      assignTo: decision.chosen.userId,
      summary: args.summary,
    })
    await afterPick(db, args.accountId, decision, ctx.routing)
  } else {
    await transitionHandoff(db, {
      conversationId: args.conversationId,
      accountId: args.accountId,
      to: 'waiting_for_human',
      reason: args.reason ?? `${args.decidedBy}:${decision.strategy}:nobody_available`,
      summary: args.summary,
    })
    if (args.hints && Object.keys(args.hints).length) {
      // The trigger just created (or kept) the HUMAN_CHAT task; give it
      // the criteria so the retry matches the same person.
      await db
        .from('tasks')
        .update({ routing: args.hints })
        .eq('account_id', args.accountId)
        .eq('conversation_id', args.conversationId)
        .eq('action_type', 'HUMAN_CHAT')
        .in('status', ['pending', 'assigned'])
    }
  }

  await db.from('assignment_events').insert({
    account_id: args.accountId,
    conversation_id: args.conversationId,
    assigned_to: decision.chosen?.userId ?? null,
    strategy: decision.strategy,
    decided_by: args.decidedBy,
    reason: args.reason ?? null,
    candidates: decision.considered,
  })

  return {
    assignedTo: decision.chosen?.userId ?? null,
    decision,
    nextAvailableAt: decision.chosen ? null : earliestNextShift(ctx.candidates, args.hints),
  }
}

export interface AssignTaskArgs {
  accountId: string
  task: Pick<Task, 'id' | 'conversation_id' | 'action_type' | 'routing'>
  strategy?: RoutingStrategy
  decidedBy: AssignConversationArgs['decidedBy']
  reason?: string
  now?: Date
}

/**
 * Route a task. A HUMAN_CHAT task is really its conversation, so it is
 * routed through `assignConversation` (the trigger then marks the task
 * in progress). Any other task is assigned directly.
 */
export async function assignTask(db: SupabaseClient, args: AssignTaskArgs): Promise<AssignResult> {
  const now = args.now ?? new Date()
  const hints = (args.task.routing ?? {}) as TaskRoutingHints

  if (args.task.action_type === 'HUMAN_CHAT' && args.task.conversation_id) {
    return assignConversation(db, {
      accountId: args.accountId,
      conversationId: args.task.conversation_id,
      strategy: args.strategy,
      hints,
      decidedBy: args.decidedBy,
      reason: args.reason,
      now,
    })
  }

  const ctx = await loadRoutingContext(db, args.accountId, now)
  const decision = pickAssignee(ctx.candidates, { strategy: args.strategy, hints, routing: ctx.routing })

  if (decision.chosen) {
    const { error } = await db
      .from('tasks')
      .update({
        assigned_to: decision.chosen.userId,
        status: 'assigned',
        assigned_at: now.toISOString(),
      })
      .eq('id', args.task.id)
      .eq('account_id', args.accountId)
      .in('status', ['pending', 'assigned'])
    if (error) throw new Error(`[routing] task assignment failed: ${error.message}`)
    await afterPick(db, args.accountId, decision, ctx.routing)
  }

  await db.from('assignment_events').insert({
    account_id: args.accountId,
    task_id: args.task.id,
    assigned_to: decision.chosen?.userId ?? null,
    strategy: decision.strategy,
    decided_by: args.decidedBy,
    reason: args.reason ?? null,
    candidates: decision.considered,
  })

  return {
    assignedTo: decision.chosen?.userId ?? null,
    decision,
    nextAvailableAt: decision.chosen ? null : earliestNextShift(ctx.candidates, hints),
  }
}

/** Advance the round-robin cursor after a pick. Read-modify-write is fine at this scale. */
async function afterPick(db: SupabaseClient, accountId: string, decision: Decision, routing: AccountRouting) {
  if (decision.strategy !== 'round_robin' || !decision.chosen) return
  await db
    .from('accounts')
    .update({ routing: { ...routing, last_assigned_user_id: decision.chosen.userId } })
    .eq('id', accountId)
}

/**
 * The soonest moment someone matching the hints comes on shift — what
 * the queue card shows ("un asesor estará disponible desde las 15:00")
 * and what the assistant can tell the customer.
 */
export function earliestNextShift(candidates: Candidate[], hints?: TaskRoutingHints): Date | null {
  let pool = candidates.filter((c) => c.snapshot.acceptsAssignments && c.availability.override !== 'off')
  if (hints?.department) pool = pool.filter((c) => c.department === hints.department)
  if (hints?.specialties?.length) {
    pool = pool.filter((c) => c.specialties.some((s) => hints.specialties!.includes(s)))
  }
  if (hints?.item_id) pool = pool.filter((c) => c.itemIds.includes(hints.item_id!))
  const starts = pool.map((c) => c.nextShiftStart).filter((d): d is Date => d instanceof Date)
  if (!starts.length) return null
  return new Date(Math.min(...starts.map((d) => d.getTime())))
}
