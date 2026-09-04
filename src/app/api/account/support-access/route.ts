import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

/**
 * /api/account/support-access — the client's half of support access.
 *
 *   GET                                    admin+  pending + live grants, plus what Altokia did here
 *   PATCH { grant_id, action }             admin+  approve | deny | revoke
 *
 * Altokia's console (the platform plane, 045) files a request; this
 * route is where the customer answers it. Two deliberate choices:
 *
 *   1. Ordinary account machinery — `requireRole('admin')` and the
 *      caller's own session client. NOT `lib/platform`, and NOT the
 *      service role. The point of the screen is that consent is given
 *      by the customer under their own identity, so the write has to
 *      pass 045's `access_grants_update` policy
 *      (`is_account_member(account_id, 'admin')`) rather than bypass
 *      it. A grant approved by the service role would be theatre.
 *   2. Expiry is evaluated here, not by a sweeper. A row can still say
 *      'pending' long after `expires_at` — the DB never rewrites it —
 *      so both the listing and the approve path filter on the clock.
 *      `has_platform_access()` does the same on the operator side, so
 *      client and operator agree on what "live" means.
 *
 * The audit half is read-only and comes from `platform_audit_log`,
 * which 045 makes readable by the affected account's admins. Nothing
 * here writes to it: the customer answering a request is not an
 * operator action, and RLS gives no INSERT to anyone but the service
 * role.
 */

/** Statuses a customer can still act on. Anything else is history. */
const LIVE_STATUSES = ['pending', 'granted'] as const

const ACTIONS = ['approve', 'deny', 'revoke'] as const
type GrantAction = (typeof ACTIONS)[number]

const GRANT_SELECT =
  'id, operator_user_id, status, reason, requested_at, granted_at, expires_at, revoked_at'

/** Enough history to answer "has anyone been in here?" without paging. */
const ACTIVITY_LIMIT = 50
const GRANT_LIMIT = 50

/**
 * The only columns this route ever writes. 045's enum has no 'denied':
 * a refusal and a withdrawal both land on 'revoked', which is what
 * `has_platform_access()` reads as "no".
 */
interface GrantPatch {
  status: 'granted' | 'revoked'
  granted_at?: string
  granted_by?: string
  revoked_at?: string
}

interface GrantRow {
  id: string
  operator_user_id: string
  status: string
  reason: string
  requested_at: string
  granted_at: string | null
  expires_at: string
  revoked_at: string | null
}

export async function GET() {
  try {
    const ctx = await requireRole('admin')
    const nowIso = new Date().toISOString()

    // Both reads are already scoped by RLS to this account; the
    // explicit account_id filter keeps the intent readable and lets
    // the (account_id, status) index do the work.
    const [grantsResult, activityResult] = await Promise.all([
      ctx.supabase
        .from('platform_access_grants')
        .select(GRANT_SELECT)
        .eq('account_id', ctx.accountId)
        .in('status', LIVE_STATUSES)
        // A request nobody answered before it ran out is not something
        // to ask the customer about — it is already dead.
        .gt('expires_at', nowIso)
        .order('requested_at', { ascending: false })
        .limit(GRANT_LIMIT),
      ctx.supabase
        .from('platform_audit_log')
        .select('id, operator_user_id, action, detail, created_at')
        .eq('account_id', ctx.accountId)
        .order('created_at', { ascending: false })
        .limit(ACTIVITY_LIMIT),
    ])

    if (grantsResult.error) {
      console.error('[GET /api/account/support-access] grants fetch error:', grantsResult.error)
      return NextResponse.json({ error: 'Failed to load support access' }, { status: 500 })
    }
    if (activityResult.error) {
      console.error('[GET /api/account/support-access] audit fetch error:', activityResult.error)
      return NextResponse.json({ error: 'Failed to load support activity' }, { status: 500 })
    }

    const grants = (grantsResult.data ?? []) as GrantRow[]

    return NextResponse.json({
      // Waiting on the customer.
      pending: grants.filter((g) => g.status === 'pending'),
      // Answered yes, and still inside the window.
      active: grants.filter((g) => g.status === 'granted'),
      activity: activityResult.data ?? [],
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireRole('admin')

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const grantId = body.grant_id
    if (typeof grantId !== 'string' || !grantId.trim()) {
      return NextResponse.json({ error: 'grant_id is required' }, { status: 400 })
    }
    if (!(ACTIONS as readonly unknown[]).includes(body.action)) {
      return NextResponse.json(
        { error: `action must be one of ${ACTIONS.join(', ')}` },
        { status: 400 },
      )
    }
    const action = body.action as GrantAction

    // The account_id filter is what makes "this grant is mine" true
    // rather than assumed. RLS enforces it as well; stating it here
    // means a policy change can never silently widen this route.
    const { data: grant, error: readError } = await ctx.supabase
      .from('platform_access_grants')
      .select('id, status, expires_at')
      .eq('id', grantId)
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    if (readError) {
      console.error('[PATCH /api/account/support-access] fetch error:', readError)
      return NextResponse.json({ error: 'Failed to load the access request' }, { status: 500 })
    }
    if (!grant) {
      return NextResponse.json({ error: 'Access request not found' }, { status: 404 })
    }

    const now = new Date()
    let patch: GrantPatch

    if (action === 'approve') {
      if (grant.status !== 'pending') {
        return NextResponse.json(
          { error: 'Only a pending request can be approved' },
          { status: 409 },
        )
      }
      // The operator chose the window when they asked. If it elapsed
      // while the request sat unanswered, approving it would hand out
      // access that is already over — make them ask again, with a
      // fresh reason the customer can read.
      if (new Date(grant.expires_at).getTime() <= now.getTime()) {
        return NextResponse.json(
          { error: 'This request has expired. Ask the Altokia team to send a new one.' },
          { status: 409 },
        )
      }
      patch = {
        status: 'granted',
        granted_at: now.toISOString(),
        // Stamped from the session, never from the body: the record of
        // who in the customer's team said yes has to be unforgeable.
        granted_by: ctx.userId,
      }
    } else if (action === 'deny') {
      if (grant.status !== 'pending') {
        return NextResponse.json(
          { error: 'Only a pending request can be denied' },
          { status: 409 },
        )
      }
      // Denied and revoked land on the same status on purpose: 045's
      // enum has no 'denied', and both mean the same thing to
      // has_platform_access() — no consent. The distinction lives in
      // whether granted_at was ever set.
      patch = { status: 'revoked', revoked_at: now.toISOString() }
    } else {
      if (grant.status !== 'granted') {
        return NextResponse.json(
          { error: 'Only an approved grant can be revoked' },
          { status: 409 },
        )
      }
      patch = { status: 'revoked', revoked_at: now.toISOString() }
    }

    // Leaving 'pending'/'granted' also frees the partial unique index
    // (one live row per account+operator), so the operator can ask
    // again later without colliding with this row.
    const { data, error } = await ctx.supabase
      .from('platform_access_grants')
      .update(patch)
      .eq('id', grant.id)
      .eq('account_id', ctx.accountId)
      .select(GRANT_SELECT)
      .single()

    if (error) {
      console.error('[PATCH /api/account/support-access] update error:', error)
      return NextResponse.json({ error: 'Failed to update the access request' }, { status: 500 })
    }

    return NextResponse.json({ grant: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}
