import type { SupabaseClient } from '@supabase/supabase-js'
import { isValidTimeZone, zoneOffsetMinutes } from '@/lib/availability'

// Who closed what this month, and whether that is better or worse than
// last month.
//
// The operations panel already shows how much was won this month — a
// number the owner can read but not act on, because it says nothing
// about who did it or which way the month is going. Those are the two
// questions actually asked at the end of every month, so they are
// answered here.
//
// The criterion is 044's, copied on purpose: a deal counts when
// `status = 'won'` and `closed_at` falls inside the month, and the month
// is bounded in **accounts.timezone** — never the browser's. Deriving
// the boundary from the device clock would give a manager in Madrid a
// different "this month" from the one their team in Lima sees, and the
// breakdown below would then contradict the counter above it.
//
// Read with the browser client: RLS scopes deals and profiles to the
// caller's account, the same way every other loader in this directory
// works.

/** Fallback zone, matching what the 044 RPC degrades to. */
const FALLBACK_TIMEZONE = 'UTC'

/**
 * How many won deals we will read per month. Counts come back exact
 * regardless (PostgREST counts server-side); only the sums are capped,
 * and `partial` says so out loud rather than presenting a floor as a
 * total.
 */
export const CLOSERS_ROW_CAP = 500

export interface ClosersMonth {
  /** Exact number of deals closed won in the window. */
  count: number
  /** Sum of deals.value over the rows read. A floor when `partial`. */
  value: number
}

export interface CloserRow {
  /**
   * profiles.id — `deals.assigned_to` is a FK to **profiles.id**
   * (migration 002), not to auth.users.id. Null when the deal is
   * nobody's.
   */
  profileId: string | null
  /** Null when the deal has no owner, or the owner left the account. */
  name: string | null
  count: number
  value: number
}

export interface ClosersSummary {
  /** The account zone the two months were bounded in. */
  timezone: string
  current: ClosersMonth
  previous: ClosersMonth
  /** This month only, biggest seller first. */
  byAdvisor: CloserRow[]
  /** True when a month held more deals than the cap, so sums are floors. */
  partial: boolean
}

/**
 * The instant a month starts, in `timeZone`.
 *
 * `monthOffset` is relative to the month `now` falls in: 0 = this month,
 * 1 = the first instant of next month (the exclusive end of this one),
 * -1 = the start of last month.
 *
 * Same technique as `atLocalTime` in lib/availability: build the wall
 * time as if it were UTC, then shift by the zone's offset at that
 * moment, which keeps it correct across DST changes.
 */
export function monthStartInZone(now: Date, timeZone: string, monthOffset = 0): Date {
  // The account's own calendar date for this instant, as YYYY-MM-DD.
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
  const [year, month] = ymd.split('-').map(Number)
  // Month arithmetic on a UTC instant: Date.UTC normalises month -1 and
  // month 12 into the neighbouring year, so December and January need no
  // special case.
  const naiveUtc = new Date(Date.UTC(year, month - 1 + monthOffset, 1, 0, 0, 0, 0))
  return new Date(naiveUtc.getTime() - zoneOffsetMinutes(naiveUtc, timeZone) * 60_000)
}

interface WonRow {
  assigned_to?: string | null
  value: number | string | null
}

export async function loadClosers(
  db: SupabaseClient,
  timeZone: string,
  now: Date = new Date(),
): Promise<ClosersSummary> {
  // An unusable zone must not take the block down: fall back the way the
  // RPC does, so the numbers stay consistent with the counters above.
  const zone = timeZone && isValidTimeZone(timeZone) ? timeZone : FALLBACK_TIMEZONE

  const monthStart = monthStartInZone(now, zone, 0).toISOString()
  const monthEnd = monthStartInZone(now, zone, 1).toISOString()
  const previousStart = monthStartInZone(now, zone, -1).toISOString()

  const [currentRes, previousRes] = await Promise.all([
    db
      .from('deals')
      .select('assigned_to, value', { count: 'exact' })
      .eq('status', 'won')
      .gte('closed_at', monthStart)
      .lt('closed_at', monthEnd)
      // Newest first, always: without an order the capped subset is an
      // arbitrary sample that can change between refreshes, so the same
      // month would show two different breakdowns minutes apart.
      .order('closed_at', { ascending: false })
      .limit(CLOSERS_ROW_CAP),
    // Last month only needs the money and the count; nobody asks who
    // closed what in a month that is already over.
    db
      .from('deals')
      .select('value', { count: 'exact' })
      .eq('status', 'won')
      .gte('closed_at', previousStart)
      .lt('closed_at', monthStart)
      .order('closed_at', { ascending: false })
      .limit(CLOSERS_ROW_CAP),
  ])

  if (currentRes.error) throw currentRes.error
  if (previousRes.error) throw previousRes.error

  const currentRows = (currentRes.data ?? []) as WonRow[]
  const previousRows = (previousRes.data ?? []) as WonRow[]
  const currentCount = currentRes.count ?? currentRows.length
  const previousCount = previousRes.count ?? previousRows.length

  return {
    timezone: zone,
    current: { count: currentCount, value: sumValue(currentRows) },
    previous: { count: previousCount, value: sumValue(previousRows) },
    byAdvisor: await byAdvisor(db, currentRows),
    partial: currentRows.length < currentCount || previousRows.length < previousCount,
  }
}

/**
 * Group this month's wins by owner and put a name on each.
 *
 * The names come from a second query rather than an embedded join: the
 * schema cache behind PostgREST's FK inference goes stale after a
 * migration and answers PGRST200, which would take the whole breakdown
 * down over a label (the same reason lib/auth/account.ts loads the
 * account with a plain lookup).
 */
async function byAdvisor(db: SupabaseClient, rows: WonRow[]): Promise<CloserRow[]> {
  const totals = new Map<string, CloserRow>()

  for (const row of rows) {
    const profileId = row.assigned_to ?? null
    // The empty string is not a valid uuid, so it can never collide with
    // a real profile id — it is only the map's key for "nobody's".
    const key = profileId ?? ''
    const entry = totals.get(key) ?? { profileId, name: null, count: 0, value: 0 }
    entry.count += 1
    entry.value += toNumber(row.value)
    totals.set(key, entry)
  }

  const ids = [...totals.values()].map((e) => e.profileId).filter((id): id is string => !!id)
  if (ids.length > 0) {
    const { data, error } = await db.from('profiles').select('id, full_name').in('id', ids)
    if (error) {
      // Rows keep their numbers and lose their names, which the UI
      // renders as unattributed — better than dropping the breakdown.
      console.error('[closers] profile names failed:', error)
    }
    for (const p of (data ?? []) as { id: string; full_name: string }[]) {
      const entry = totals.get(p.id)
      if (entry) entry.name = p.full_name
    }
  }

  // Biggest seller first — the order the question is asked in. Ties fall
  // back to deal count, then to a stable alphabetical order.
  return [...totals.values()].sort(
    (a, b) =>
      b.value - a.value ||
      b.count - a.count ||
      (a.name ?? '').localeCompare(b.name ?? ''),
  )
}

/** deals.value is NUMERIC, which some clients hand back as a string. */
function toNumber(value: number | string | null | undefined): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

function sumValue(rows: WonRow[]): number {
  return rows.reduce((total, row) => total + toNumber(row.value), 0)
}
