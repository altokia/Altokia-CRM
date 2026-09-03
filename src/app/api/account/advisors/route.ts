import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { isAccountRole } from '@/lib/auth/roles'
import { loadRoutingContext } from '@/lib/routing'
import type { Availability } from '@/lib/availability'
import type { AccountRouting, AdvisorProfile } from '@/types'

/**
 * GET /api/account/advisors
 *
 * The team as routing sees it: every member who can take assignments
 * (owner/admin/agent — the same set `loadRoutingContext` considers),
 * with their profile, weekly windows, computed availability right
 * now, next shift start and current load. Any member may read it: the
 * queue card and the assign dropdown both need to show who is free.
 *
 * Built on `loadRoutingContext` so the settings page shows exactly
 * what the picker would see — no second definition of "available".
 */

export interface AdvisorListEntry {
  user_id: string
  full_name: string
  avatar_url: string | null
  role: string
  profile: AdvisorProfile | null
  schedules: Array<{ weekday: number; start: string; end: string }>
  availability: Availability
  next_shift_start: string | null
  load: number
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount()

    const [routingCtx, profilesRes, advisorsRes] = await Promise.all([
      loadRoutingContext(ctx.supabase, ctx.accountId),
      ctx.supabase
        .from('profiles')
        .select('user_id, avatar_url, account_role')
        .eq('account_id', ctx.accountId),
      ctx.supabase.from('advisor_profiles').select('*').eq('account_id', ctx.accountId),
    ])

    if (profilesRes.error || advisorsRes.error) {
      console.error('[GET /api/account/advisors] fetch error:', profilesRes.error ?? advisorsRes.error)
      return NextResponse.json({ error: 'Failed to load advisors' }, { status: 500 })
    }

    const profileByUser = new Map(
      (profilesRes.data ?? []).map((p) => [
        p.user_id as string,
        { avatar_url: (p.avatar_url as string | null) ?? null, role: p.account_role as string },
      ]),
    )
    const advisorByUser = new Map(
      (advisorsRes.data ?? []).map((a) => [a.user_id as string, a as AdvisorProfile]),
    )

    const advisors: AdvisorListEntry[] = routingCtx.candidates
      .map((c) => {
        const profile = profileByUser.get(c.userId)
        return {
          user_id: c.userId,
          full_name: c.fullName,
          avatar_url: profile?.avatar_url ?? null,
          role: profile && isAccountRole(profile.role) ? profile.role : 'agent',
          profile: advisorByUser.get(c.userId) ?? null,
          schedules: c.snapshot.schedules.map((w) => ({ weekday: w.weekday, start: w.start, end: w.end })),
          availability: c.availability,
          next_shift_start: c.nextShiftStart ? c.nextShiftStart.toISOString() : null,
          load: c.snapshot.load,
        }
      })
      .sort((a, b) => a.full_name.localeCompare(b.full_name))

    return NextResponse.json({
      timezone: routingCtx.timezone,
      routing: routingCtx.routing as AccountRouting,
      advisors,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
