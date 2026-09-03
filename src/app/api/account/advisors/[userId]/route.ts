import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { parseHHMM } from '@/lib/availability'
import type { AdvisorProfile } from '@/types'

/**
 * PUT /api/account/advisors/[userId]
 *
 * Body: { department?, specialties?, item_ids?, capacity?,
 *         accepts_assignments?, availability_override?, schedules? }
 *
 * Admin edits an advisor's routing attributes. The profile row is
 * upserted with only the fields present (so a partial save never
 * resets what was left out). `schedules`, when present, is the WHOLE
 * weekly plan: every existing window for that user is replaced — a
 * diff would buy nothing for a dozen rows and could leave stale
 * windows behind.
 *
 * Validation mirrors the DB constraints (weekday 0-6, start < end,
 * HH:mm) so the user sees a 400 with a reason rather than a bare
 * constraint violation.
 */

const OVERRIDES = ['available', 'busy', 'off'] as const

interface ScheduleInput {
  weekday: number
  start: string
  end: string
}

class BadRequest extends Error {}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const { userId } = await params

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    let profilePatch: Partial<AdvisorProfile>
    let schedules: ScheduleInput[] | undefined
    try {
      profilePatch = parseProfile(body)
      schedules = parseSchedules(body.schedules)
    } catch (err) {
      if (err instanceof BadRequest) {
        return NextResponse.json({ error: err.message }, { status: 400 })
      }
      throw err
    }

    // Only a member of this account can be an advisor of it. The FK
    // alone would accept any auth user.
    const { data: member } = await ctx.supabase
      .from('profiles')
      .select('user_id')
      .eq('account_id', ctx.accountId)
      .eq('user_id', userId)
      .maybeSingle()
    if (!member) {
      return NextResponse.json(
        { error: 'That user is not a member of this account' },
        { status: 404 },
      )
    }

    // Upsert sets only the columns in the payload, so an absent field
    // keeps its stored value (or the column default on first save).
    const { data: profile, error: profileError } = await ctx.supabase
      .from('advisor_profiles')
      .upsert({ user_id: userId, account_id: ctx.accountId, ...profilePatch }, { onConflict: 'user_id' })
      .select('*')
      .single()
    if (profileError) {
      console.error('[PUT /api/account/advisors/[userId]] profile upsert error:', profileError)
      return NextResponse.json({ error: 'Failed to save advisor profile' }, { status: 500 })
    }

    if (schedules) {
      const { error: deleteError } = await ctx.supabase
        .from('advisor_schedules')
        .delete()
        .eq('account_id', ctx.accountId)
        .eq('user_id', userId)
      if (deleteError) {
        console.error('[PUT /api/account/advisors/[userId]] schedule delete error:', deleteError)
        return NextResponse.json({ error: 'Failed to save schedule' }, { status: 500 })
      }
      if (schedules.length) {
        const { error: insertError } = await ctx.supabase.from('advisor_schedules').insert(
          schedules.map((s) => ({
            account_id: ctx.accountId,
            user_id: userId,
            weekday: s.weekday,
            start_time: s.start,
            end_time: s.end,
          })),
        )
        if (insertError) {
          console.error('[PUT /api/account/advisors/[userId]] schedule insert error:', insertError)
          return NextResponse.json({ error: 'Failed to save schedule' }, { status: 500 })
        }
      }
    }

    // Always answer with what is stored, in the same shape GET returns.
    const { data: rows } = await ctx.supabase
      .from('advisor_schedules')
      .select('weekday, start_time, end_time')
      .eq('account_id', ctx.accountId)
      .eq('user_id', userId)
      .order('weekday', { ascending: true })
      .order('start_time', { ascending: true })

    return NextResponse.json({
      profile: profile as AdvisorProfile,
      schedules: (rows ?? []).map((r) => ({
        weekday: r.weekday as number,
        // Postgres TIME comes back as 'HH:mm:ss'.
        start: (r.start_time as string).slice(0, 5),
        end: (r.end_time as string).slice(0, 5),
      })),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

// ---------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------

function parseProfile(body: Record<string, unknown>): Partial<AdvisorProfile> {
  const patch: Partial<AdvisorProfile> = {}

  if (body.department !== undefined) {
    if (body.department !== null && typeof body.department !== 'string') {
      throw new BadRequest('department must be a string or null')
    }
    const dept = typeof body.department === 'string' ? body.department.trim() : null
    patch.department = dept || null
  }
  if (body.specialties !== undefined) {
    patch.specialties = parseStringList(body.specialties, 'specialties')
  }
  if (body.item_ids !== undefined) {
    patch.item_ids = parseStringList(body.item_ids, 'item_ids')
  }
  if (body.capacity !== undefined) {
    if (typeof body.capacity !== 'number' || !Number.isInteger(body.capacity) || body.capacity < 0) {
      throw new BadRequest('capacity must be an integer >= 0')
    }
    patch.capacity = body.capacity
  }
  if (body.accepts_assignments !== undefined) {
    if (typeof body.accepts_assignments !== 'boolean') {
      throw new BadRequest('accepts_assignments must be a boolean')
    }
    patch.accepts_assignments = body.accepts_assignments
  }
  if (body.availability_override !== undefined) {
    const o = body.availability_override
    if (o !== null && !(OVERRIDES as readonly unknown[]).includes(o)) {
      throw new BadRequest('availability_override must be "available", "busy", "off" or null')
    }
    patch.availability_override = o as AdvisorProfile['availability_override']
  }
  return patch
}

/** Trimmed, non-empty, de-duplicated strings. */
function parseStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new BadRequest(`${field} must be an array of strings`)
  }
  const seen = new Set<string>()
  for (const raw of value as string[]) {
    const s = raw.trim()
    if (s) seen.add(s)
  }
  return [...seen]
}

function parseSchedules(value: unknown): ScheduleInput[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new BadRequest('schedules must be an array')

  return value.map((raw, i) => {
    if (!raw || typeof raw !== 'object') throw new BadRequest(`schedules[${i}] must be an object`)
    const { weekday, start, end } = raw as Record<string, unknown>
    if (typeof weekday !== 'number' || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw new BadRequest(`schedules[${i}].weekday must be an integer 0-6 (Sunday = 0)`)
    }
    if (typeof start !== 'string' || typeof end !== 'string') {
      throw new BadRequest(`schedules[${i}] needs start and end as HH:mm`)
    }
    let startMin: number
    let endMin: number
    try {
      startMin = parseHHMM(start)
      endMin = parseHHMM(end)
    } catch {
      throw new BadRequest(`schedules[${i}] times must be HH:mm (24h)`)
    }
    // No overnight windows in v1 (matches the DB check): split them.
    if (startMin >= endMin) {
      throw new BadRequest(`schedules[${i}] must end after it starts`)
    }
    return { weekday, start, end }
  })
}
