import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { isValidTimeZone } from '@/lib/availability'
import type { AccountRouting, RoutingStrategy } from '@/types'

/**
 * PATCH /api/account/routing
 *
 * Body: { strategy?, fallback?, timezone? }
 *
 * The per-business assignment policy read by lib/routing, plus the
 * time zone every schedule is evaluated in. `accounts.routing` is one
 * JSON object, so the patch is merged over the stored value — in
 * particular the round-robin cursor (`last_assigned_user_id`) survives
 * a settings save.
 */

const STRATEGIES: readonly RoutingStrategy[] = [
  'manual',
  'round_robin',
  'least_load',
  'by_schedule',
  'by_department',
  'by_specialty',
  'by_item',
  'previous_advisor',
  'priority',
]
const FALLBACKS = ['queue', 'ai_continue'] as const

export async function PATCH(request: Request) {
  try {
    const ctx = await requireRole('admin')

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { strategy, fallback, timezone } = body
    if (strategy !== undefined && !(STRATEGIES as readonly unknown[]).includes(strategy)) {
      return NextResponse.json(
        { error: `strategy must be one of ${STRATEGIES.join(', ')}` },
        { status: 400 },
      )
    }
    if (fallback !== undefined && !(FALLBACKS as readonly unknown[]).includes(fallback)) {
      return NextResponse.json(
        { error: `fallback must be one of ${FALLBACKS.join(', ')}` },
        { status: 400 },
      )
    }
    if (timezone !== undefined && (typeof timezone !== 'string' || !isValidTimeZone(timezone))) {
      return NextResponse.json({ error: 'timezone must be a valid IANA time zone' }, { status: 400 })
    }
    if (strategy === undefined && fallback === undefined && timezone === undefined) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }

    const { data: account, error: readError } = await ctx.supabase
      .from('accounts')
      .select('routing, timezone')
      .eq('id', ctx.accountId)
      .maybeSingle()
    if (readError || !account) {
      console.error('[PATCH /api/account/routing] fetch error:', readError)
      return NextResponse.json({ error: 'Failed to load account' }, { status: 500 })
    }

    const current = ((account.routing as AccountRouting | null) ?? {}) as AccountRouting
    const routing: AccountRouting = {
      ...current,
      ...(strategy !== undefined ? { strategy: strategy as RoutingStrategy } : {}),
      ...(fallback !== undefined ? { fallback: fallback as AccountRouting['fallback'] } : {}),
    }

    const patch: { routing: AccountRouting; timezone?: string } = { routing }
    if (timezone !== undefined) patch.timezone = timezone as string

    // accounts_update RLS requires admin+, which requireRole guaranteed.
    const { data, error } = await ctx.supabase
      .from('accounts')
      .update(patch)
      .eq('id', ctx.accountId)
      .select('routing, timezone')
      .single()
    if (error) {
      console.error('[PATCH /api/account/routing] update error:', error)
      return NextResponse.json({ error: 'Failed to update routing' }, { status: 500 })
    }

    return NextResponse.json({ routing: data.routing ?? routing, timezone: data.timezone })
  } catch (err) {
    return toErrorResponse(err)
  }
}
