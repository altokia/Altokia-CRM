import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
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
 *
 * ============================================================
 * Walking the account list at platform scale
 * ============================================================
 *
 * This used to `SELECT id, routing FROM accounts` with no limit and
 * then pay two round trips per account, so the pass grew linearly with
 * the tenant count — around 20 s at 1 000 accounts, and past any sane
 * scheduling interval well before 10 000. Three things changed, none of
 * them what the job *does*:
 *
 *   - Accounts are read a page at a time, ordered by `id`, resumed from
 *     the `cursor` query parameter. `id` is a stable total order, so a
 *     tenant signing up mid-sweep can never displace another.
 *   - A pass is bounded by a time budget AND an account cap, and says
 *     in its JSON whether it reached the end. `has_more: true` means
 *     accounts were left untouched — call again immediately with
 *     `?cursor=<next_cursor>`. Nothing is ever dropped silently.
 *   - One bounded probe per page replaces the two round trips per
 *     account: most tenants have nothing waiting and nothing due on any
 *     given pass, and paying a query to find that out was the cost.
 *
 * Fairness note. Ordering by `id` is stable and needs no new column,
 * but on its own it is only fair if the caller follows `next_cursor`;
 * a caller that always starts from the beginning would keep serving the
 * low-id tenants. The fair order is "least recently swept first", which
 * needs one column. Deliberately NOT migrated here — this is the SQL,
 * the orchestrator decides:
 *
 *     ALTER TABLE accounts
 *       ADD COLUMN IF NOT EXISTS cron_tasks_at TIMESTAMPTZ;
 *     CREATE INDEX IF NOT EXISTS idx_accounts_cron_tasks
 *       ON accounts (cron_tasks_at NULLS FIRST, id);
 *     COMMENT ON COLUMN accounts.cron_tasks_at IS
 *       'When /api/tasks/cron last finished a pass over this account. '
 *       'NULL = never. The sweep takes the oldest first so no tenant '
 *       'is starved by a busier neighbour.';
 *
 * With that column the page query becomes
 *     ORDER BY cron_tasks_at NULLS FIRST, id
 * and each page ends with one write —
 *     UPDATE accounts SET cron_tasks_at = now() WHERE id = ANY($1)
 * — after which `cursor` is no longer needed at all.
 */

// Highest the plan allows, and the same ceiling the broadcast resume
// route already claims (src/app/api/whatsapp/broadcast/[id]/resume).
// A pass stops itself well before this; the declaration is the safety
// net for the pass that doesn't.
export const maxDuration = 300

/** Accounts fetched per round trip. Also the size of the `.in()` probe
 *  filter below, which is why it is 100 and not 1 000: the probe travels
 *  as a query string. */
const ACCOUNT_PAGE = 100
/** Accounts a single pass will touch before handing back a cursor. */
const DEFAULT_MAX_ACCOUNTS = 500
const MAX_MAX_ACCOUNTS = 5000
/** Wall-clock budget for a pass, comfortably inside `maxDuration`. */
const TIME_BUDGET_MS = 240_000
/** Unchanged: 50 tasks per pass per account, per list. */
const TASKS_PER_ACCOUNT = 50
/** A probe returning this many rows is assumed to have been cut off. */
const PROBE_LIMIT = 1000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type StopReason = 'exhausted' | 'account_cap' | 'time_budget'
type AccountRow = { id: string; routing: AccountRouting | null }

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

  const url = new URL(request.url)

  const cursorParam = url.searchParams.get('cursor')
  if (cursorParam !== null && !UUID_RE.test(cursorParam)) {
    return NextResponse.json(
      { error: 'cursor must be the account UUID this endpoint returned as next_cursor' },
      { status: 400 },
    )
  }

  let maxAccounts = DEFAULT_MAX_ACCOUNTS
  const maxParam = url.searchParams.get('max_accounts')
  if (maxParam !== null) {
    const parsed = Number(maxParam)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_MAX_ACCOUNTS) {
      return NextResponse.json(
        { error: `max_accounts must be an integer between 1 and ${MAX_MAX_ACCOUNTS}` },
        { status: 400 },
      )
    }
    maxAccounts = parsed
  }

  const admin = supabaseAdmin()
  const startedAt = Date.now()

  let cursor: string | null = cursorParam
  let scanned = 0
  let queried = 0
  let hasMore = false
  let stoppedBy: StopReason = 'exhausted'
  let retried = 0
  let assigned = 0
  let reminded = 0
  const processedIds: string[] = []
  let pageStampFrom = 0
  // Accounts whose per-account row cap was hit, i.e. work is left over
  // even though the account itself was visited. Reported so a pass that
  // says "done" is actually done.
  let capped = 0

  while (!hasMore) {
    // Fresh per page: a pass can legitimately last minutes, and "is
    // anyone on shift now?" must not be answered with a stale clock.
    const now = new Date()
    const nowIso = now.toISOString()

    // Ordered by when this job last touched the account (046), never
    // touched first, oldest next. The pass resumes from server state,
    // so the external pinger stays one stateless curl — a cursor the
    // caller has to thread back means `>/dev/null` drops it and the
    // tail of the customer list is never processed at all.
    const accountsQuery = admin
      .from('accounts')
      .select('id, routing')
      .order('cron_tasks_at', { ascending: true, nullsFirst: true })
      .order('id', { ascending: true })
      .limit(ACCOUNT_PAGE)

    const { data: page, error: accountsError } = await accountsQuery
    if (accountsError) {
      console.error('[tasks/cron] account page failed:', accountsError.message)
      return NextResponse.json({ error: accountsError.message }, { status: 500 })
    }

    const accounts = (page ?? []) as AccountRow[]
    if (accounts.length === 0) break

    const ids = accounts.map((a) => a.id)

    // Which accounts in this page actually have work? Two bounded
    // queries instead of two per account. Both use the partial indexes
    // 041 created (idx_tasks_account_open, idx_tasks_due).
    const [waitingProbe, dueProbe] = await Promise.all([
      admin
        .from('tasks')
        .select('account_id')
        .in('account_id', ids)
        .eq('status', 'pending')
        .is('assigned_to', null)
        .limit(PROBE_LIMIT),
      admin
        .from('tasks')
        .select('account_id')
        .in('account_id', ids)
        .in('status', ['assigned', 'in_progress'])
        .not('assigned_to', 'is', null)
        .lte('due_at', nowIso)
        .is('due_notified_at', null)
        .limit(PROBE_LIMIT),
    ])

    const waiting = busySet(waitingProbe.data, waitingProbe.error, 'waiting')
    const due = busySet(dueProbe.data, dueProbe.error, 'due')

    for (const account of accounts) {
      if (scanned >= maxAccounts) {
        stoppedBy = 'account_cap'
        hasMore = true
        break
      }
      if (Date.now() - startedAt >= TIME_BUDGET_MS) {
        stoppedBy = 'time_budget'
        hasMore = true
        break
      }

      // A null probe means "could not be trusted" (error, or cut off at
      // PROBE_LIMIT), so we fall back to asking per account — slower,
      // never wrong. Silently skipping an account is not an option.
      const hasWaiting = waiting === null || waiting.has(account.id)
      const hasDue = due === null || due.has(account.id)

      if (hasWaiting || hasDue) {
        queried++
        let accountCapped = false
        if (hasWaiting) {
          const result = await retryWaitingTasks(admin, account, now)
          retried += result.retried
          assigned += result.assigned
          accountCapped = accountCapped || result.capped
        }
        if (hasDue) {
          const result = await sendDueReminders(admin, account.id, nowIso)
          reminded += result.reminded
          accountCapped = accountCapped || result.capped
        }
        if (accountCapped) capped++
      }

      cursor = account.id
      processedIds.push(account.id)
      scanned++
    }

    // Stamp only what this pass actually got through. An account cut
    // off by the time budget keeps its old watermark and therefore
    // sorts first on the next tick, which is what makes the sweep
    // fair rather than merely round-robin.
    if (processedIds.length > pageStampFrom) {
      const slice = processedIds.slice(pageStampFrom)
      pageStampFrom = processedIds.length
      const { error: stampError } = await admin
        .from('accounts')
        .update({ cron_tasks_at: new Date().toISOString() })
        .in('id', slice)
      if (stampError) {
        // Without the stamp the next pass repeats these accounts. That
        // is wasteful but not wrong, so it is logged, not fatal.
        console.error('[tasks/cron] watermark update failed:', stampError.message)
      }
    }

    // A short page is the end of the list; anything else means there is
    // at least one more page to ask for.
    if (!hasMore && accounts.length < ACCOUNT_PAGE) break
  }

  return NextResponse.json({
    retried,
    assigned,
    reminded,
    // `scanned` is how far the cursor moved; `queried` is how many of
    // those accounts the probe said were worth a per-account read.
    accounts_scanned: scanned,
    accounts_queried: queried,
    // An account can be visited and still have work left: the per-account
    // read is bounded. Saying "exhausted" while rows remain is how a
    // backlog stays invisible, so a row cap forces has_more.
    accounts_capped: capped,
    has_more: hasMore || capped > 0,
    next_cursor: hasMore ? cursor : null,
    stopped_by: capped > 0 && !hasMore ? 'row_cap' : stoppedBy,
  })
}

// ---------------------------------------------------------------------
// Per-account work — unchanged in meaning, only ever reached for an
// account the probe (or its fallback) says has something to do.
// ---------------------------------------------------------------------

/** Retry routing for tasks still waiting for a person. */
async function retryWaitingTasks(
  admin: SupabaseClient,
  account: AccountRow,
  now: Date,
): Promise<{ retried: number; assigned: number; capped: boolean }> {
  const accountId = account.id
  const routing = (account.routing ?? {}) as AccountRouting

  const { data: pending, error } = await admin
    .from('tasks')
    .select('id, conversation_id, action_type, routing, priority, created_at')
    .eq('account_id', accountId)
    .eq('status', 'pending')
    .is('assigned_to', null)
    .order('created_at', { ascending: true })
    .limit(TASKS_PER_ACCOUNT)

  if (error) {
    console.error('[tasks/cron] waiting-task read failed for account', accountId, error.message)
    return { retried: 0, assigned: 0, capped: false }
  }

  let retried = 0
  let assigned = 0
  for (const task of (pending ?? []) as Pick<
    Task,
    'id' | 'conversation_id' | 'action_type' | 'routing'
  >[]) {
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
      console.error(
        '[tasks/cron] routing failed for task',
        task.id,
        err instanceof Error ? err.message : err,
      )
    }
  }
  // A full page means the account has more waiting tasks than one pass
  // reads, so the caller must not report the sweep as complete.
  return { retried, assigned, capped: (pending?.length ?? 0) >= TASKS_PER_ACCOUNT }
}

/** One reminder per task whose due_at has passed. */
async function sendDueReminders(
  admin: SupabaseClient,
  accountId: string,
  nowIso: string,
): Promise<{ reminded: number; capped: boolean }> {
  // Oldest due first, so the 50-row bound drops the tasks that only
  // just came due rather than the ones that have been overdue longest.
  // That ordering is also what lets idx_tasks_due carry the query.
  const { data: due, error } = await admin
    .from('tasks')
    .select('id, assigned_to, conversation_id, contact_id, title, details, action_type, priority, due_at')
    .eq('account_id', accountId)
    .in('status', ['assigned', 'in_progress'])
    .not('assigned_to', 'is', null)
    .lte('due_at', nowIso)
    .is('due_notified_at', null)
    .order('due_at', { ascending: true })
    .limit(TASKS_PER_ACCOUNT)

  if (error) {
    console.error('[tasks/cron] due-task read failed for account', accountId, error.message)
    return { reminded: 0, capped: false }
  }

  let reminded = 0
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
  return { reminded, capped: (due?.length ?? 0) >= TASKS_PER_ACCOUNT }
}

/**
 * Turn a probe result into the set of accounts that have work, or
 * `null` when the answer cannot be trusted — the query failed, or it
 * came back full and may therefore be missing accounts. `null` means
 * "ask every account in the page", which is what this route did before.
 */
function busySet(
  data: unknown[] | null,
  error: { message: string } | null,
  label: string,
): Set<string> | null {
  if (error) {
    console.error(`[tasks/cron] ${label} probe failed:`, error.message)
    return null
  }
  if (!data || data.length >= PROBE_LIMIT) return null
  return new Set((data as { account_id: string }[]).map((row) => row.account_id))
}
