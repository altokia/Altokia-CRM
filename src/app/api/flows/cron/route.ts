import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { resolveFallbackPolicy } from '@/lib/flows/fallback'

/**
 * Sweep abandoned active flow runs.
 *
 * Reads each active run's parent-flow `fallback_policy.on_timeout_hours`
 * to compute the staleness cutoff (default 24h), then marks any run
 * past its cutoff as `timed_out`. Writes a matching `flow_run_events`
 * row for the audit trail.
 *
 * Without this sweep, a customer who abandons a flow mid-conversation
 * keeps a row in `idx_one_active_run_per_contact` (the partial unique
 * index on `flow_runs WHERE status='active'`) forever — blocking any
 * new triggers for them. The cron is therefore not optional.
 *
 * Auth: re-uses `AUTOMATION_CRON_SECRET` so operators only have one
 * secret to provision. The two endpoints (`/api/automations/cron`
 * and this one) are independent operations; we keep them on separate
 * URLs so one failing doesn't block the other.
 *
 * Hosting: hit on a schedule (Vercel Cron / GitHub Actions / external
 * pinger). A 5-minute interval is more than enough for a 24h timeout
 * default; once per hour would also be acceptable for low-volume
 * tenants.
 *
 * ============================================================
 * Walking the account list at platform scale
 * ============================================================
 *
 * This used to pull EVERY active run on the platform in one unbounded
 * query and then compare ages in JavaScript — which threw away the
 * partial index migration 010 created for exactly this sweep
 * (`idx_flow_runs_active_advanced ON flow_runs(last_advanced_at) WHERE
 * status = 'active'`). At 1 000 tenants that is one query returning
 * every open conversation on the platform, on a 5-minute timer.
 *
 * Now the sweep walks accounts a page at a time, ordered by `id` and
 * resumed from the `cursor` query parameter, and asks each account for
 * its OLDEST active runs only, capped. Oldest-first is what makes the
 * cap safe: a stale run can never hide behind fresher ones, and the
 * ordering is served straight off that partial index.
 *
 * What still happens in JavaScript, and why: the cutoff is per-flow
 * (`flows.fallback_policy`), so the test is "this run against its own
 * parent's policy" — a comparison between two columns, which PostgREST
 * cannot express. It stays exact in JS over a bounded set. Moving it
 * into SQL needs an RPC, which would also let the cap be applied after
 * the age test instead of before it:
 *
 *     CREATE INDEX IF NOT EXISTS idx_flow_runs_account_active_advanced
 *       ON flow_runs (account_id, last_advanced_at) WHERE status = 'active';
 *
 *     CREATE OR REPLACE FUNCTION stale_flow_runs(p_account UUID, p_limit INT)
 *     RETURNS SETOF flow_runs LANGUAGE sql STABLE AS $$
 *       SELECT r.* FROM flow_runs r JOIN flows f ON f.id = r.flow_id
 *       WHERE r.account_id = p_account
 *         AND r.status = 'active'
 *         AND r.last_advanced_at <= now() - (CASE
 *               WHEN jsonb_typeof(f.fallback_policy->'on_timeout_hours') = 'number'
 *                AND (f.fallback_policy->>'on_timeout_hours')::numeric > 0
 *               THEN (f.fallback_policy->>'on_timeout_hours')::numeric
 *               ELSE 24 END * INTERVAL '1 hour')
 *       ORDER BY r.last_advanced_at
 *       LIMIT p_limit;
 *     $$;
 *
 * (The CASE mirrors `resolveFallbackPolicy` exactly, garbage values
 * included — a non-numeric or non-positive setting falls back to 24h.)
 *
 * Fairness note. Ordering by `id` is stable and needs no new column,
 * but it is only fair if the caller follows `next_cursor`; a caller
 * that always starts from the beginning would keep sweeping the low-id
 * tenants. The fair order is "least recently swept first", one column.
 * Deliberately NOT migrated here — this is the SQL, the orchestrator
 * decides:
 *
 *     ALTER TABLE accounts
 *       ADD COLUMN IF NOT EXISTS cron_flows_at TIMESTAMPTZ;
 *     CREATE INDEX IF NOT EXISTS idx_accounts_cron_flows
 *       ON accounts (cron_flows_at NULLS FIRST, id);
 *     COMMENT ON COLUMN accounts.cron_flows_at IS
 *       'When /api/flows/cron last finished a pass over this account. '
 *       'NULL = never. The sweep takes the oldest first so no tenant '
 *       'is starved by a busier neighbour.';
 *
 * With that column the page query becomes
 *     ORDER BY cron_flows_at NULLS FIRST, id
 * and each page ends with one write —
 *     UPDATE accounts SET cron_flows_at = now() WHERE id = ANY($1)
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
/** Oldest-first, so this cap can only ever defer runs that are younger
 *  than 200 other active runs in the same account — never a stale one. */
const RUNS_PER_ACCOUNT = 200
/** A probe returning this many rows is assumed to have been cut off. */
const PROBE_LIMIT = 1000

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type StopReason = 'exhausted' | 'account_cap' | 'time_budget'

type RunRow = {
  id: string
  flow_id: string
  user_id: string
  contact_id: string | null
  last_advanced_at: string
  flows: { fallback_policy: unknown } | { fallback_policy: unknown }[] | null
}

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  // Constant-time compare so an attacker who can hit the endpoint
  // can't recover the secret byte-by-byte from response-time deltas.
  // Length pre-check is required by timingSafeEqual (throws otherwise)
  // and leaks only the length itself, which isn't sensitive.
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
  let scanned = 0
  let queried = 0
  let swept = 0
  let hasMore = false
  let stoppedBy: StopReason = 'exhausted'

  while (!hasMore) {
    // Fresh per page: a pass can legitimately last minutes, and the age
    // test must not be answered with a stale clock.
    const now = new Date()

    const accountsQuery = admin
      .from('accounts')
      .select('id')
      // Ordered by when this job last touched the account (046), never
      // touched first. The pass resumes from server state, so the
      // external pinger stays one stateless curl instead of having to
      // thread next_cursor back — which it cannot, since it pipes the
      // response to /dev/null.
      .order('cron_flows_at', { ascending: true, nullsFirst: true })
      .order('id', { ascending: true })
      .limit(ACCOUNT_PAGE)

    const { data: page, error: accountsError } = await accountsQuery
    if (accountsError) {
      console.error('[flows-cron] account page failed:', accountsError.message)
      return NextResponse.json({ error: accountsError.message }, { status: 500 })
    }

    const accounts = (page ?? []) as { id: string }[]
    if (accounts.length === 0) break

    const ids = accounts.map((a) => a.id)

    // Which accounts in this page have any active run at all? One
    // bounded query instead of one per account — most tenants are not
    // mid-flow with anyone at any given minute, and paying a round trip
    // to find that out is what does not survive 1 000 accounts.
    const { data: probeRows, error: probeError } = await admin
      .from('flow_runs')
      .select('account_id')
      .in('account_id', ids)
      .eq('status', 'active')
      .limit(PROBE_LIMIT)

    const active = busySet(probeRows, probeError)

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
      if (active === null || active.has(account.id)) {
        queried++
        swept += await sweepAccount(admin, account.id, now)
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
        .update({ cron_flows_at: new Date().toISOString() })
        .in('id', slice)
      if (stampError) {
        // Missing the stamp only repeats work next tick; never fatal.
        console.error('[flows/cron] watermark update failed:', stampError.message)
      }
    }

    // A short page is the end of the list; anything else means there is
    // at least one more page to ask for.
    if (!hasMore && accounts.length < ACCOUNT_PAGE) break
  }

  return NextResponse.json({
    swept,
    // `scanned` is how far the cursor moved; `queried` is how many of
    // those accounts the probe said were worth a per-account read.
    accounts_scanned: scanned,
    accounts_queried: queried,
    has_more: hasMore,
    next_cursor: hasMore ? cursor : null,
    stopped_by: stoppedBy,
  })
}

/**
 * Time out the stale runs of one account. Unchanged in meaning: each
 * run is still compared against its own flow's `on_timeout_hours`.
 */
async function sweepAccount(
  admin: SupabaseClient,
  accountId: string,
  now: Date,
): Promise<number> {
  // Oldest idle first. The cap therefore drops the runs that were
  // advanced most recently — the ones that cannot be stale yet unless
  // 200 older runs in the same account are stale too, and those get
  // swept on this very pass. The ordering is what puts
  // idx_flow_runs_active_advanced back to work.
  const { data: runs, error } = await admin
    .from('flow_runs')
    .select('id, flow_id, user_id, contact_id, last_advanced_at, flows ( fallback_policy )')
    .eq('account_id', accountId)
    .eq('status', 'active')
    .order('last_advanced_at', { ascending: true })
    .limit(RUNS_PER_ACCOUNT)

  if (error) {
    console.error('[flows-cron] active-run scan failed for account', accountId, error.message)
    return 0
  }
  if (!runs?.length) return 0

  let swept = 0
  for (const r of runs as RunRow[]) {
    const flowsField = Array.isArray(r.flows) ? r.flows[0] : r.flows
    const policy = resolveFallbackPolicy(flowsField?.fallback_policy ?? null)
    const lastAdvanced = new Date(r.last_advanced_at)
    const ageHours = (now.getTime() - lastAdvanced.getTime()) / (1000 * 60 * 60)
    if (ageHours < policy.on_timeout_hours) continue

    // Mark timed_out — guarded by the precondition `status='active'`
    // so concurrent advance from a late inbound doesn't overwrite a
    // legitimate update.
    const { data: updated } = await admin
      .from('flow_runs')
      .update({
        status: 'timed_out',
        ended_at: now.toISOString(),
        end_reason: 'stale_sweep',
      })
      .eq('id', r.id)
      .eq('status', 'active')
      .select('id')

    if (Array.isArray(updated) && updated.length > 0) {
      await admin.from('flow_run_events').insert({
        flow_run_id: r.id,
        event_type: 'timeout',
        payload: {
          age_hours: Math.round(ageHours * 10) / 10,
          policy_hours: policy.on_timeout_hours,
        },
      })
      swept += 1
    }
  }
  return swept
}

/**
 * Turn the probe result into the set of accounts that have active runs,
 * or `null` when the answer cannot be trusted — the query failed, or it
 * came back full and may therefore be missing accounts. `null` means
 * "ask every account in the page", which is what this route did before.
 */
function busySet(
  data: unknown[] | null,
  error: { message: string } | null,
): Set<string> | null {
  if (error) {
    console.error('[flows-cron] active-account probe failed:', error.message)
    return null
  }
  if (!data || data.length >= PROBE_LIMIT) return null
  return new Set((data as { account_id: string }[]).map((row) => row.account_id))
}
