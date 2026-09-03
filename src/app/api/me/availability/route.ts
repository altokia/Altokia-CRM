import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

/**
 * POST /api/me/availability
 *
 * Body: { override: "available" | "busy" | "off" | null }
 *
 * The advisor's own switch ("no disponible ahora"). Goes through the
 * `set_my_availability` RPC (migration 041) because advisor_profiles
 * is admin-only under RLS; the function is SECURITY DEFINER and reads
 * the account from the caller's profile, never from the body. `null`
 * hands control back to the schedule.
 */

const OVERRIDES = ['available', 'busy', 'off'] as const

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent')

    const body = (await request.json().catch(() => null)) as { override?: unknown } | null
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const override = body.override === undefined ? null : body.override
    if (override !== null && !(OVERRIDES as readonly unknown[]).includes(override)) {
      return NextResponse.json(
        { error: 'override must be "available", "busy", "off" or null' },
        { status: 400 },
      )
    }

    const { error } = await ctx.supabase.rpc('set_my_availability', { p_override: override })
    if (error) {
      console.error('[POST /api/me/availability] rpc error:', error)
      return NextResponse.json({ error: 'Failed to update availability' }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
