// ============================================================
// /api/platform/accounts/[id]/access — asking to look, and giving
// the right back.
//
//   POST   — file a request. Creates a `pending` grant; only the
//            client's own admin can move it to `granted`
//            (/api/account/support-access, enforced by 045's RLS).
//   DELETE — hand the access back before it expires.
//
// Nothing in this file grants anything. An operator inserting their
// own `granted` row would make the entire consent mechanism theatre,
// so the status this route can write is `pending` on the way in and
// `revoked` on the way out — never anything in between.
// ============================================================

import { NextResponse } from 'next/server'

import {
  logPlatformAction,
  requirePlatformOperator,
  toPlatformErrorResponse,
} from '@/lib/platform'

const MIN_REASON_LEN = 10
const MAX_REASON_LEN = 500
const MIN_HOURS = 1
const MAX_HOURS = 72

const GRANT_SELECT =
  'id, account_id, operator_user_id, status, reason, requested_at, granted_at, granted_by, revoked_at, expires_at'

/**
 * POST /api/platform/accounts/[id]/access
 *
 * Body: { reason, hours }
 *
 * `reason` is shown to the customer verbatim, which is why ten
 * characters is the floor: "debug" is not a reason a customer can
 * weigh, and a consent screen that shows one teaches customers to
 * approve without reading.
 *
 * `hours` caps at 72 because every grant is time-boxed by design —
 * `has_platform_access()` compares `expires_at` to NOW() on every
 * check, so an over-long window is the difference between "support
 * looked once in March" and "support can read everything".
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requirePlatformOperator()
    const { id } = await params

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (reason.length < MIN_REASON_LEN) {
      return NextResponse.json(
        {
          error: `reason must be at least ${MIN_REASON_LEN} characters — the client reads it before deciding`,
        },
        { status: 400 }
      )
    }
    if (reason.length > MAX_REASON_LEN) {
      return NextResponse.json(
        { error: `reason must be ${MAX_REASON_LEN} characters or fewer` },
        { status: 400 }
      )
    }

    const hours = body.hours
    if (
      typeof hours !== 'number' ||
      !Number.isInteger(hours) ||
      hours < MIN_HOURS ||
      hours > MAX_HOURS
    ) {
      return NextResponse.json(
        { error: `hours must be a whole number between ${MIN_HOURS} and ${MAX_HOURS}` },
        { status: 400 }
      )
    }

    const { data: account, error: accountError } = await ctx.db
      .from('accounts')
      .select('id, name')
      .eq('id', id)
      .maybeSingle()

    if (accountError) {
      console.error('[POST /api/platform/.../access] account error:', accountError)
      return NextResponse.json(
        { error: 'Failed to load the account' },
        { status: 500 }
      )
    }
    if (!account) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString()

    const { data: grant, error } = await ctx.db
      .from('platform_access_grants')
      .insert({
        account_id: id,
        operator_user_id: ctx.userId,
        status: 'pending',
        reason,
        expires_at: expiresAt,
      })
      .select(GRANT_SELECT)
      .single()

    if (error) {
      // 23505 = idx_access_grants_one_open: this operator already has a
      // live request or a live grant here. That is not an error the
      // operator needs to fix, it is the answer to their question, so
      // hand back the row they already hold rather than a constraint
      // name they cannot act on.
      if (error.code === '23505') {
        const { data: existing } = await ctx.db
          .from('platform_access_grants')
          .select(GRANT_SELECT)
          .eq('account_id', id)
          .eq('operator_user_id', ctx.userId)
          .in('status', ['pending', 'granted'])
          .maybeSingle()

        return NextResponse.json(
          {
            error:
              existing?.status === 'granted'
                ? 'You already hold access to this client.'
                : 'You already have a request waiting for this client to answer.',
            grant: existing ?? null,
          },
          { status: 409 }
        )
      }

      console.error('[POST /api/platform/.../access] insert error:', error)
      return NextResponse.json(
        { error: 'Failed to request access' },
        { status: 500 }
      )
    }

    await logPlatformAction(ctx, {
      accountId: id,
      action: 'ACCESS_REQUESTED',
      detail: { grant_id: grant.id, reason, hours, expires_at: expiresAt },
    })

    return NextResponse.json({ grant }, { status: 201 })
  } catch (err) {
    return toPlatformErrorResponse(err)
  }
}

/**
 * DELETE /api/platform/accounts/[id]/access
 *
 * Give back your own access (or withdraw your own pending request).
 * Scoped to `operator_user_id = ctx.userId` on purpose: revoking
 * somebody else's grant is the client's prerogative, exercised from
 * their own support-access screen.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requirePlatformOperator()
    const { id } = await params

    // Read before writing: the audit row wants the status the grant
    // was in (withdrawing a request and handing back live access are
    // different acts), and the update itself would only ever report
    // 'revoked' back.
    const { data: live, error: readError } = await ctx.db
      .from('platform_access_grants')
      .select(GRANT_SELECT)
      // Only a live row can be handed back; re-revoking history would
      // rewrite timestamps the client may already have been shown.
      .eq('account_id', id)
      .eq('operator_user_id', ctx.userId)
      .in('status', ['pending', 'granted'])
      .maybeSingle()

    if (readError) {
      console.error('[DELETE /api/platform/.../access] fetch error:', readError)
      return NextResponse.json(
        { error: 'Failed to load your access' },
        { status: 500 }
      )
    }
    if (!live) {
      return NextResponse.json(
        { error: 'You hold no live request or grant for this client.' },
        { status: 404 }
      )
    }

    const nowIso = new Date().toISOString()
    const { data: revoked, error } = await ctx.db
      .from('platform_access_grants')
      .update({ status: 'revoked', revoked_at: nowIso })
      .eq('id', live.id)
      .in('status', ['pending', 'granted'])
      .select(GRANT_SELECT)
      .maybeSingle()

    if (error) {
      console.error('[DELETE /api/platform/.../access] update error:', error)
      return NextResponse.json(
        { error: 'Failed to release access' },
        { status: 500 }
      )
    }
    if (!revoked) {
      // The client revoked it themselves between the two statements.
      return NextResponse.json(
        { error: 'That access was already closed.' },
        { status: 409 }
      )
    }

    await logPlatformAction(ctx, {
      accountId: id,
      action: 'ACCESS_RELEASED',
      detail: {
        grant_id: revoked.id,
        // Distinguishes "I withdrew my request" from "I handed back
        // access I was actually using".
        released_from: live.status,
        was_granted_at: revoked.granted_at ?? null,
      },
    })

    return NextResponse.json({ grant: revoked })
  } catch (err) {
    return toPlatformErrorResponse(err)
  }
}
