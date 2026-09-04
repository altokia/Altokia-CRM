/**
 * What a plan actually includes, resolved for one account.
 *
 * Two places store a ceiling and both matter:
 *
 *   platform_plans.limits — the price list (050). "básico gets 3 seats".
 *   accounts.limits       — this client's exceptions (045). "give this
 *                           one 5 seats, they are worth it".
 *
 * The account wins, key by key. That is the whole design: a salesperson
 * can hand a specific customer more room without inventing a fourth plan
 * that nobody can price. A key that appears in neither means no ceiling —
 * so a limit the price list has not grown yet silently allows everything,
 * which is the correct default for a feature nobody has decided to cap.
 *
 * FAILING OPEN IS DELIBERATE
 * --------------------------
 * Every read path here swallows its error and returns "no limits". A
 * paying customer locked out of inviting a colleague because PostgREST
 * hiccuped is a support call and a refund; the same customer sneaking a
 * fourth seat onto a three-seat plan is a line item on the next invoice.
 * The asymmetry is not close, so nothing in this module can ever be the
 * reason an action is refused when the database did not answer.
 *
 * Callers: this takes any SupabaseClient. The tenant's own RLS-scoped
 * client works (an account can read its own row, and platform_plans is
 * readable by every signed-in user per 050), and so does the platform
 * service-role client.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

/** The limit keys 050 seeds. Free-form on purpose — a new ceiling is a
 *  row edit in the console, not a migration and not a deploy. */
export type LimitKey =
  | 'seats'
  | 'contacts'
  | 'ai_replies_per_month'
  | 'knowledge_documents'
  | 'catalog_items'
  | (string & {})

export interface LimitCheck {
  /** False only when a ceiling is known AND already reached. */
  allowed: boolean
  /** The ceiling, or null for "no limit" (absent key, or read failure). */
  limit: number | null
  /** Echoed back so the caller doesn't recount to build a message. */
  used: number
  /**
   * The account's plan code, for the refusal message. Not part of the
   * limit decision — it is here so naming the tier ("your básico plan
   * allows 3") costs no extra round trip.
   */
  plan: string | null
}

/**
 * A ceiling was reached. Carries the numbers so the route can answer
 * with something a human can act on instead of "forbidden".
 *
 * `status` is 409, not 403: nothing is wrong with the caller's
 * permissions — the request conflicts with the current state of the
 * account, and buying a bigger plan resolves it.
 */
export class LimitExceededError extends Error {
  readonly status = 409 as const
  /** Machine-readable, stable across locales and limit keys. */
  readonly code = 'limit_exceeded' as const
  /** Which ceiling, e.g. 'seats'. */
  readonly limitKey: string
  readonly limit: number
  readonly used: number
  readonly plan: string | null

  constructor(limitKey: string, limit: number, used: number, plan: string | null) {
    super(
      plan
        ? `The '${plan}' plan allows ${limit} ${limitKey} (${used} already in use). Upgrade the plan to add more.`
        : `This account allows ${limit} ${limitKey} (${used} already in use). Upgrade the plan to add more.`,
    )
    this.name = 'LimitExceededError'
    this.limitKey = limitKey
    this.limit = limit
    this.used = used
    this.plan = plan
  }
}

// ------------------------------------------------------------
// The plan catalogue, cached
// ------------------------------------------------------------
// Three rows that change when someone edits the price list, read on
// every limit check. Caching them in process is what keeps the promise
// of "one query per check": the account row is fetched every time (it
// carries the per-client override and must be fresh), the catalogue is
// not.
//
// Deliberately NOT done as a PostgREST embed on accounts → platform_plans.
// The FK that would drive it (accounts_plan_fkey) landed in 050, and an
// embed over a relationship PostgREST has not re-cached fails with
// PGRST200 — the exact failure lib/auth/account.ts documents at length.
// Here it would fail *open* and silently, so no limit would ever apply
// and nobody would notice. A second cached query is cheaper than a
// feature that quietly does nothing.

const PLAN_CACHE_TTL_MS = 60_000

let planCache: { at: number; byCode: Map<string, Record<string, number>> } | null = null
/** De-dupes concurrent misses so a cold start doesn't fan out N queries. */
let planCacheInFlight: Promise<Map<string, Record<string, number>>> | null = null

async function loadCatalogue(db: SupabaseClient): Promise<Map<string, Record<string, number>>> {
  try {
    const { data, error } = await db.from('platform_plans').select('code, limits')
    if (error || !data) {
      console.warn('[limits] plan catalogue read failed; treating plans as uncapped:', error)
      // Do NOT cache a failure — the next call should retry rather than
      // spend a minute pretending every plan is unlimited.
      return new Map<string, Record<string, number>>()
    }
    const byCode = new Map<string, Record<string, number>>()
    for (const row of data as { code?: unknown; limits?: unknown }[]) {
      if (typeof row.code !== 'string') continue
      byCode.set(row.code, toLimitMap(row.limits))
    }
    planCache = { at: Date.now(), byCode }
    return byCode
  } catch (err) {
    // Never rejects: a thrown fetch would otherwise become an unhandled
    // rejection for every caller parked on the shared promise.
    console.warn('[limits] plan catalogue read threw; treating plans as uncapped:', err)
    return new Map<string, Record<string, number>>()
  }
}

async function planCatalogue(db: SupabaseClient): Promise<Map<string, Record<string, number>>> {
  if (planCache && Date.now() - planCache.at < PLAN_CACHE_TTL_MS) return planCache.byCode

  const inFlight = planCacheInFlight ?? loadCatalogue(db)
  planCacheInFlight = inFlight
  try {
    return await inFlight
  } finally {
    // Cleared by whoever is awaiting rather than from inside
    // loadCatalogue: a synchronous throw there would clear the slot
    // *before* it was filled and leave a settled promise cached forever,
    // which would disable every limit until the process restarted.
    planCacheInFlight = null
  }
}

// ------------------------------------------------------------
// Normalising jsonb into numbers
// ------------------------------------------------------------

/**
 * A single stored value as a ceiling, or null for "no ceiling".
 *
 * jsonb accepts anything, so junk (a string, an object, a negative) has
 * to mean something. It means "no limit" — see the fail-open note above.
 * Numeric strings are read, because a console text input is one bad
 * parseInt away from storing "10".
 */
function toLimitValue(raw: unknown): number | null {
  const n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim() !== ''
        ? Number(raw)
        : NaN
  if (!Number.isFinite(n) || n < 0) return null
  return Math.floor(n)
}

function toLimitMap(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const n = toLimitValue(value)
    if (n !== null) out[key] = n
  }
  return out
}

interface AccountLimits {
  limits: Record<string, number>
  plan: string | null
}

async function loadAccountLimits(
  db: SupabaseClient,
  accountId: string,
): Promise<AccountLimits> {
  let row: { plan?: unknown; limits?: unknown } | null = null
  try {
    const { data, error } = await db
      .from('accounts')
      .select('plan, limits')
      .eq('id', accountId)
      .maybeSingle()
    if (error) throw error
    row = data
  } catch (err) {
    // Includes the pre-050 case where `plan` is still free text and the
    // FK does not exist: unreadable is unreadable, and the answer is
    // always "let them through".
    console.warn('[limits] account read failed; allowing the action:', err)
    return { limits: {}, plan: null }
  }

  if (!row) {
    // No readable account row — RLS, or an id that does not exist.
    return { limits: {}, plan: null }
  }

  const plan = typeof row.plan === 'string' && row.plan !== '' ? row.plan : null
  const planLimits = plan ? ((await planCatalogue(db)).get(plan) ?? {}) : {}

  // Merge, account last. An account key whose value is not a usable
  // number (null, "", {}) is an explicit lift: it removes the plan's
  // ceiling for this client rather than falling back to it. That is the
  // console's way of saying "unlimited seats for them" without editing
  // the shared price list.
  const merged: Record<string, number> = { ...planLimits }
  const overrides = row.limits
  if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
    for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) {
      const n = toLimitValue(value)
      if (n === null) delete merged[key]
      else merged[key] = n
    }
  }

  return { limits: merged, plan }
}

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

/**
 * Every ceiling that applies to this account, plan and per-client
 * overrides already merged. A key that is absent has no ceiling.
 *
 * Never throws. An unreadable account or catalogue yields `{}`, which
 * every caller reads as "allowed".
 */
export async function resolveLimits(
  db: SupabaseClient,
  accountId: string,
): Promise<Record<string, number>> {
  const { limits } = await loadAccountLimits(db, accountId)
  return limits
}

/**
 * Is there room for one more?
 *
 * `currentCount` is what the caller already counted — this module does
 * not know how to count seats, contacts or catalogue rows, and guessing
 * would put a second definition of "a member" in the codebase. Compare
 * with `<`: a limit of 3 means the 4th is refused.
 *
 * Never throws; on any read failure it returns `{ allowed: true,
 * limit: null }`.
 */
export async function checkLimit(
  db: SupabaseClient,
  accountId: string,
  key: LimitKey,
  currentCount: number,
): Promise<LimitCheck> {
  const { limits, plan } = await loadAccountLimits(db, accountId)
  const limit = Object.prototype.hasOwnProperty.call(limits, key) ? limits[key] : null
  return {
    allowed: limit === null || currentCount < limit,
    limit,
    used: currentCount,
    plan,
  }
}

/** Test seam: drop the cached price list. */
export function resetPlanCache(): void {
  planCache = null
  planCacheInFlight = null
}
