/**
 * The platform plane: Altokia acting on its customers' accounts.
 *
 * This is the mirror of lib/auth/account.ts, for the other kind of
 * caller. A tenant route asks "which account is this user in, and may
 * they do this here". A platform route asks "does this user work for
 * Altokia, and is this client one they are allowed to touch right now".
 *
 * Two rules hold everywhere in here, and they are the whole reason the
 * module exists rather than each route reaching for the service-role
 * key on its own:
 *
 *   1. Identity always comes from the caller's own session. The
 *      service-role client is only ever used *after* that session has
 *      been proven to belong to an operator, and only to run the query
 *      the operator is entitled to run.
 *   2. Anything that reads or changes a client's data writes an audit
 *      row. Not as a courtesy: the client can read that log (045), so
 *      "who at Altokia opened my inbox" is a question with an answer.
 *
 * Reading a client's *content* additionally needs consent — a granted,
 * unexpired row in platform_access_grants. Operational metadata (status,
 * plan, whether the number is connected) does not: an operator has to
 * be able to see that a customer is broken without asking permission
 * first.
 */

import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient as createServerClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/ai/admin-client'

export const PLATFORM_ROLES = ['support', 'billing', 'owner'] as const
export type PlatformRole = (typeof PLATFORM_ROLES)[number]

/** Ascending, matching the Postgres enum's own ordering (045). */
const RANK: Record<PlatformRole, number> = { support: 1, billing: 2, owner: 3 }

export function isPlatformRole(value: unknown): value is PlatformRole {
  return typeof value === 'string' && (PLATFORM_ROLES as readonly string[]).includes(value)
}

export interface PlatformContext {
  /** The operator's own auth user id — the subject of every audit row. */
  userId: string
  role: PlatformRole
  /**
   * Service-role client. Bypasses RLS by design: cross-tenant reads are
   * the point of this plane. Every use must be preceded by a role check
   * and followed by an audit entry.
   */
  db: SupabaseClient
}

export class PlatformAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'PlatformAuthError'
  }
}

/**
 * Resolve the caller as Altokia staff, or throw.
 *
 * Deliberately says "Not found" rather than "You are not an operator":
 * the existence of the platform console is not something an ordinary
 * customer needs confirmed by probing its routes.
 */
export async function requirePlatformOperator(
  min: PlatformRole = 'support',
): Promise<PlatformContext> {
  const supabase = await createServerClient()
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser()
  if (error || !user) throw new PlatformAuthError('Not found', 404)

  // Read the roster with the admin client: platform_operators is
  // readable only by operators, so a non-operator asking under RLS
  // would get an empty result that is indistinguishable from a
  // misconfigured policy. Reading it directly makes the negative
  // answer authoritative.
  const db = supabaseAdmin()
  const { data, error: rosterError } = await db
    .from('platform_operators')
    .select('role')
    .eq('user_id', user.id)
    .maybeSingle()

  if (rosterError) {
    console.error('[platform] roster lookup failed:', rosterError)
    throw new PlatformAuthError('Could not verify operator', 500)
  }
  if (!data || !isPlatformRole(data.role)) throw new PlatformAuthError('Not found', 404)
  if (RANK[data.role] < RANK[min]) {
    throw new PlatformAuthError(`This action requires the '${min}' platform role`, 403)
  }

  return { userId: user.id, role: data.role, db }
}

/**
 * Throw unless this operator currently holds the client's consent.
 *
 * Call it before reading anything a customer would consider theirs:
 * conversations, messages, contacts, the knowledge base. Expiry is
 * evaluated in SQL (045's has_platform_access), so a grant that ran out
 * a minute ago is already refused.
 */
export async function requirePlatformAccess(
  ctx: PlatformContext,
  accountId: string,
): Promise<void> {
  const { data, error } = await ctx.db
    .from('platform_access_grants')
    .select('id, expires_at')
    .eq('account_id', accountId)
    .eq('operator_user_id', ctx.userId)
    .eq('status', 'granted')
    .gt('expires_at', new Date().toISOString())
    .maybeSingle()

  if (error) {
    console.error('[platform] access check failed:', error)
    throw new PlatformAuthError('Could not verify access', 500)
  }
  if (!data) {
    throw new PlatformAuthError(
      'This client has not granted you access. Request it and wait for an admin to approve.',
      403,
    )
  }
}

export interface AuditEntry {
  accountId?: string | null
  /** UPPER_SNAKE verb, e.g. ACCOUNT_SUSPENDED, ACCESS_REQUESTED, INBOX_VIEWED. */
  action: string
  detail?: Record<string, unknown>
}

/**
 * Record what an operator did. Best-effort by design: a failure to log
 * must not roll back the operation the customer is waiting on, but it
 * is logged loudly because a silent gap in an audit trail is worse than
 * a noisy one.
 */
export async function logPlatformAction(
  ctx: PlatformContext,
  entry: AuditEntry,
): Promise<void> {
  try {
    const { error } = await ctx.db.from('platform_audit_log').insert({
      operator_user_id: ctx.userId,
      account_id: entry.accountId ?? null,
      action: entry.action,
      detail: entry.detail ?? {},
    })
    if (error) throw error
  } catch (err) {
    console.error('[platform] AUDIT WRITE FAILED', entry.action, entry.accountId, err)
  }
}

/** Map a thrown platform error onto a response. Mirrors toErrorResponse. */
export function toPlatformErrorResponse(err: unknown): NextResponse {
  if (err instanceof PlatformAuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status })
  }
  console.error('[platform] unhandled error:', err)
  return NextResponse.json({ error: 'Internal error' }, { status: 500 })
}
