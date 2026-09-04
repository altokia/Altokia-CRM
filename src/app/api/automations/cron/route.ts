import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { resumePendingExecution } from '@/lib/automations/engine'
import type { AutomationContext } from '@/lib/automations/engine'

/**
 * Drain due `automation_pending_executions` rows. Meant to be hit
 * on a schedule (Vercel Cron / external pinger) — requires a shared
 * secret via the `x-cron-secret` header to match
 * `AUTOMATION_CRON_SECRET`.
 *
 * The claim step (status = 'running') serves as a simple lock so
 * overlapping invocations don't double-process rows. Best-effort
 * only; expensive SELECT ... FOR UPDATE is avoided in favor of a
 * two-step UPDATE-by-id.
 *
 * ============================================================
 * Draining fairly at platform scale
 * ============================================================
 *
 * The old query took the 50 oldest due rows on the WHOLE PLATFORM. One
 * busy tenant with a hundred waits coming due could therefore eat the
 * entire budget and every other tenant's automations would simply not
 * run that minute — and the endpoint said nothing about it. Two things
 * changed, neither of them what the job *does*:
 *
 *   - The limit is now per account (50 each) inside a bounded batch of
 *     accounts, so no tenant can spend another tenant's budget.
 *   - Accounts are read a page at a time, ordered by `id`, resumed from
 *     the `cursor` query parameter, and the pass reports whether it
 *     reached the end. `has_more: true` means accounts were left
 *     untouched — call again immediately with `?cursor=<next_cursor>`.
 *     Nothing is ever dropped silently.
 *
 * One bounded probe per page replaces the round trip per account: at
 * 1 000 tenants almost nothing is due at any given minute, and asking
 * each account individually was the whole cost of the pass. The probe
 * is served by 006's `idx_automation_pending_due` (partial on `run_at`
 * WHERE status='pending'); the per-account read would rather have the
 * composite, which is worth adding whenever the next migration lands:
 *
 *     CREATE INDEX IF NOT EXISTS idx_automation_pending_account_due
 *       ON automation_pending_executions (account_id, run_at)
 *       WHERE status = 'pending';
 *
 * Fairness note. Ordering by `id` is stable and needs no new column,
 * but it is only fair if the caller follows `next_cursor`; a caller
 * that always starts from the beginning would keep draining the low-id
 * tenants. The fair order is "least recently drained first", one
 * column. Deliberately NOT migrated here — this is the SQL, the
 * orchestrator decides:
 *
 *     ALTER TABLE accounts
 *       ADD COLUMN IF NOT EXISTS cron_automations_at TIMESTAMPTZ;
 *     CREATE INDEX IF NOT EXISTS idx_accounts_cron_automations
 *       ON accounts (cron_automations_at NULLS FIRST, id);
 *     COMMENT ON COLUMN accounts.cron_automations_at IS
 *       'When /api/automations/cron last finished a pass over this '
 *       'account. NULL = never. The drain takes the oldest first so no '
 *       'tenant is starved by a busier neighbour.';
 *
 * With that column the page query becomes
 *     ORDER BY cron_automations_at NULLS FIRST, id
 * and each page ends with one write —
 *     UPDATE accounts SET cron_automations_at = now() WHERE id = ANY($1)
 * — after which `cursor` is no longer needed at all.
 */

// Highest the plan allows, and the same ceiling the broadcast resume
// route already claims (src/app/api/whatsapp/broadcast/[id]/resume).
// This job sends real messages, so a pass can be genuinely slow; it
// stops itself on the time budget below well before this.
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
/** Was the platform-wide limit; now what each account gets per pass. */
const PENDING_PER_ACCOUNT = 50
/** A probe returning this many rows is assumed to have been cut off. */
const PROBE_LIMIT = 1000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type StopReason = 'exhausted' | 'account_cap' | 'time_budget'

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
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
  const processedIds: string[] = []
  let pageStampFrom = 0
  // Accounts visited but left with work: the per-account read is
  // bounded, so "exhausted" would otherwise hide a backlog.
  let capped = 0
  let scanned = 0
  let queried = 0
  let processed = 0
  let hasMore = false
  let stoppedBy: StopReason = 'exhausted'

  while (!hasMore) {
    // Fresh per page: a pass can legitimately last minutes, and a wait
    // that comes due halfway through it should be picked up, not judged
    // against the clock the pass started with.
    const nowIso = new Date().toISOString()

    const accountsQuery = admin
      .from('accounts')
      .select('id')
      // Ordered by when this job last touched the account (046), never
      // touched first. The pass resumes from server state, so the
      // external pinger stays one stateless curl instead of having to
      // thread next_cursor back — which it cannot, since it pipes the
      // response to /dev/null.
      .order('cron_automations_at', { ascending: true, nullsFirst: true })
      .order('id', { ascending: true })
      .limit(ACCOUNT_PAGE)

    const { data: page, error: accountsError } = await accountsQuery
    if (accountsError) {
      console.error('[automations/cron] account page failed:', accountsError.message)
      return NextResponse.json({ error: accountsError.message }, { status: 500 })
    }

    const accounts = (page ?? []) as { id: string }[]
    if (accounts.length === 0) break

    const ids = accounts.map((a) => a.id)

    // Which accounts in this page have anything due? One bounded query
    // instead of one per account.
    const { data: probeRows, error: probeError } = await admin
      .from('automation_pending_executions')
      .select('account_id')
      .in('account_id', ids)
      .eq('status', 'pending')
      .lte('run_at', nowIso)
      .limit(PROBE_LIMIT)

    const dueAccounts = busySet(probeRows, probeError)

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
      if (dueAccounts === null || dueAccounts.has(account.id)) {
        queried++
        const drained = await drainAccount(
          admin,
          account.id,
          nowIso,
          startedAt + TIME_BUDGET_MS,
        )
        processed += drained.processed
        if (drained.capped) capped++
      }

      cursor = account.id
      processedIds.push(account.id)
      scanned++
    }

    // Stamp only what this pass got through. An account cut short by
    // the time budget keeps its old watermark and therefore sorts first
    // on the next tick, which is what makes the sweep fair.
    if (processedIds.length > pageStampFrom) {
      const slice = processedIds.slice(pageStampFrom)
      pageStampFrom = processedIds.length
      const { error: stampError } = await admin
        .from('accounts')
        .update({ cron_automations_at: new Date().toISOString() })
        .in('id', slice)
      if (stampError) {
        // Missing the stamp only repeats work next tick; never fatal.
        console.error('[automations/cron] watermark update failed:', stampError.message)
      }
    }

    // A short page is the end of the list; anything else means there is
    // at least one more page to ask for.
    if (!hasMore && accounts.length < ACCOUNT_PAGE) break
  }

  return NextResponse.json({
    processed,
    // `scanned` is how far the cursor moved; `queried` is how many of
    // those accounts the probe said had something due.
    accounts_scanned: scanned,
    accounts_queried: queried,
    accounts_capped: capped,
    has_more: hasMore || capped > 0,
    next_cursor: hasMore ? cursor : null,
    stopped_by: capped > 0 && !hasMore ? 'row_cap' : stoppedBy,
  })
}

/**
 * Resume one account's due waits, oldest first, capped. Unchanged in
 * meaning: the same claim-then-resume, one row at a time.
 */
async function drainAccount(
  admin: SupabaseClient,
  accountId: string,
  nowIso: string,
  /**
   * Wall-clock instant this pass must stop by.
   *
   * The outer loop only checks the clock between accounts, but one
   * account's drain sends real WhatsApp messages one at a time — fifty
   * rows at a second or two each is a minute and a half for a single
   * account. A drain that starts near the budget runs past maxDuration
   * and the invocation is killed: no JSON, no counters, and every row
   * already flipped to 'running' stays there, because nothing else ever
   * moves it back to 'pending'. Checking the deadline per row is what
   * keeps those waits recoverable.
   */
  deadline: number,
): Promise<{ processed: number; capped: boolean }> {
  const { data: due, error } = await admin
    .from('automation_pending_executions')
    .select('*')
    .eq('account_id', accountId)
    .eq('status', 'pending')
    .lte('run_at', nowIso)
    .order('run_at', { ascending: true })
    .limit(PENDING_PER_ACCOUNT)

  if (error) {
    console.error('[automations/cron] due read failed for account', accountId, error.message)
    return { processed: 0, capped: false }
  }
  if (!due || due.length === 0) return { processed: 0, capped: false }

  let processed = 0
  for (const row of due) {
    // Stop before claiming another row rather than after: an unclaimed
    // row is simply picked up next tick.
    if (Date.now() >= deadline) {
      return { processed, capped: true }
    }
    const { data: claim } = await admin
      .from('automation_pending_executions')
      .update({ status: 'running' })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (!claim) continue

    await resumePendingExecution({
      id: row.id as string,
      automation_id: row.automation_id as string,
      // account_id is NOT NULL on automation_pending_executions
      // post-017; the engine uses it for tenant-scoped lookups.
      account_id: row.account_id as string,
      user_id: row.user_id as string,
      contact_id: (row.contact_id as string | null) ?? null,
      log_id: (row.log_id as string | null) ?? null,
      parent_step_id: (row.parent_step_id as string | null) ?? null,
      branch: (row.branch as 'yes' | 'no' | null) ?? null,
      next_step_position: row.next_step_position as number,
      context: (row.context as AutomationContext) ?? {},
    })
    processed++
  }
  return { processed, capped: due.length >= PENDING_PER_ACCOUNT }
}

/**
 * Turn the probe result into the set of accounts with work due, or
 * `null` when the answer cannot be trusted — the query failed, or it
 * came back full and may therefore be missing accounts. `null` means
 * "ask every account in the page".
 */
function busySet(
  data: unknown[] | null,
  error: { message: string } | null,
): Set<string> | null {
  if (error) {
    console.error('[automations/cron] due-account probe failed:', error.message)
    return null
  }
  if (!data || data.length >= PROBE_LIMIT) return null
  return new Set((data as { account_id: string }[]).map((row) => row.account_id))
}
