// ============================================================
// /api/platform/operators/[userId] — take someone off the roster.
//
// `owner` only, and with one guard that has nothing to do with
// permissions and everything to do with recoverability: the platform
// must never be left without an owner. `platform_operators` is written
// through a policy that requires `is_platform_operator('owner')`, so
// an empty owner set means nobody can ever add one back — the only way
// out would be a service-role INSERT run by hand against production.
// ============================================================

import { NextResponse } from 'next/server'

import {
  logPlatformAction,
  requirePlatformOperator,
  toPlatformErrorResponse,
} from '@/lib/platform'

/**
 * DELETE /api/platform/operators/[userId]
 *
 * Removing yourself is allowed — leaving is not the dangerous act.
 * Removing the LAST owner is refused, whoever asks.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const ctx = await requirePlatformOperator('owner')
    const { userId } = await params

    const { data: target, error: targetError } = await ctx.db
      .from('platform_operators')
      .select('user_id, role, full_name, note, created_at')
      .eq('user_id', userId)
      .maybeSingle()

    if (targetError) {
      console.error('[DELETE /api/platform/operators/[userId]] fetch error:', targetError)
      return NextResponse.json(
        { error: 'Failed to load that operator' },
        { status: 500 }
      )
    }
    if (!target) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    if (target.role === 'owner') {
      const { count, error: countError } = await ctx.db
        .from('platform_operators')
        .select('user_id', { count: 'exact', head: true })
        .eq('role', 'owner')

      if (countError) {
        console.error('[DELETE /api/platform/operators/[userId]] owner count error:', countError)
        return NextResponse.json(
          { error: 'Failed to verify the owner count' },
          { status: 500 }
        )
      }
      if ((count ?? 0) <= 1) {
        return NextResponse.json(
          {
            error:
              'This is the last platform owner. Promote another operator to owner first — with none, nobody can change the roster again.',
          },
          { status: 400 }
        )
      }
    }

    const { error } = await ctx.db
      .from('platform_operators')
      .delete()
      .eq('user_id', userId)

    if (error) {
      console.error('[DELETE /api/platform/operators/[userId]] delete error:', error)
      return NextResponse.json(
        { error: 'Failed to remove the operator' },
        { status: 500 }
      )
    }

    // Their audit history stays: platform_audit_log.operator_user_id is
    // ON DELETE SET NULL against auth.users and holds no FK to this
    // table at all, so what they did remains on the record.
    await logPlatformAction(ctx, {
      action: 'OPERATOR_REMOVED',
      detail: {
        user_id: userId,
        role: target.role,
        full_name: target.full_name ?? null,
        self: userId === ctx.userId,
      },
    })

    return NextResponse.json({ removed: target })
  } catch (err) {
    return toPlatformErrorResponse(err)
  }
}
