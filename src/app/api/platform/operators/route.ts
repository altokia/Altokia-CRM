// ============================================================
// /api/platform/operators — who works for Altokia.
//
//   GET  — the roster, readable by any operator. Knowing which
//          colleagues can reach customer accounts is exactly the kind
//          of thing staff should not have to ask permission to see.
//   POST — add someone. `owner` only.
//
// The roster is not account data: `platform_operators` is orthogonal
// to tenancy (045), which is what lets an operator exist without being
// a member of anybody's account and keeps 017's one-login-one-account
// rule intact.
// ============================================================

import { NextResponse } from 'next/server'

import {
  PLATFORM_ROLES,
  isPlatformRole,
  logPlatformAction,
  requirePlatformOperator,
  toPlatformErrorResponse,
} from '@/lib/platform'

const MAX_NOTE_LEN = 500

interface OperatorRow {
  user_id: string
  role: string
  full_name: string | null
  note: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

interface ProfileRow {
  user_id: string
  full_name: string | null
  email: string | null
}

/**
 * GET /api/platform/operators
 *
 * Two queries, never one per row: the roster, then every identity it
 * mentions (members and the colleagues who added them) resolved from
 * `profiles` in a single `.in()`. `profiles.email` is the only place
 * the service role can read an address through PostgREST — the `auth`
 * schema is not exposed to it.
 */
export async function GET() {
  try {
    const ctx = await requirePlatformOperator()

    const { data, error } = await ctx.db
      .from('platform_operators')
      .select('user_id, role, full_name, note, created_by, created_at, updated_at')
      .order('created_at', { ascending: true })

    if (error) {
      console.error('[GET /api/platform/operators] fetch error:', error)
      return NextResponse.json(
        { error: 'Failed to load the operator roster' },
        { status: 500 }
      )
    }

    const operators = (data ?? []) as OperatorRow[]
    if (operators.length === 0) {
      return NextResponse.json({ operators: [] })
    }

    const ids = Array.from(
      new Set(
        operators.flatMap((op) =>
          op.created_by ? [op.user_id, op.created_by] : [op.user_id]
        )
      )
    )

    const { data: profiles, error: profileError } = await ctx.db
      .from('profiles')
      .select('user_id, full_name, email')
      .in('user_id', ids)

    if (profileError) {
      // Names are decoration; the roster itself is the answer.
      console.warn('[GET /api/platform/operators] identity lookup failed:', profileError)
    }

    const byUser = new Map<string, ProfileRow>()
    for (const row of (profiles ?? []) as ProfileRow[]) {
      byUser.set(row.user_id, row)
    }

    return NextResponse.json({
      operators: operators.map((op) => ({
        ...op,
        // The roster's own full_name wins: it is what the person who
        // added them typed, and a client-facing profile name may be
        // something else entirely.
        full_name: op.full_name ?? byUser.get(op.user_id)?.full_name ?? null,
        email: byUser.get(op.user_id)?.email ?? null,
        created_by_name: op.created_by
          ? (byUser.get(op.created_by)?.full_name ??
            byUser.get(op.created_by)?.email ??
            null)
          : null,
        is_you: op.user_id === ctx.userId,
      })),
    })
  } catch (err) {
    return toPlatformErrorResponse(err)
  }
}

/**
 * POST /api/platform/operators
 *
 * Body: { email, role, note? }  —  `owner` only.
 *
 * The person must already have a login. `platform_operators.user_id`
 * references `auth.users`, so there is nothing to point the row at
 * before they sign up, and creating an auth user on somebody's behalf
 * from a staff console is not a decision this endpoint should make.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requirePlatformOperator('owner')

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const email =
      typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json(
        { error: 'email must be a valid email address' },
        { status: 400 }
      )
    }

    if (!isPlatformRole(body.role)) {
      return NextResponse.json(
        { error: `role must be one of ${PLATFORM_ROLES.join(', ')}` },
        { status: 400 }
      )
    }
    const role = body.role

    let note: string | null = null
    if (body.note !== undefined && body.note !== null) {
      if (typeof body.note !== 'string' || body.note.length > MAX_NOTE_LEN) {
        return NextResponse.json(
          { error: `note must be a string of ${MAX_NOTE_LEN} characters or fewer` },
          { status: 400 }
        )
      }
      note = body.note.trim() || null
    }

    const { data: matches, error: lookupError } = await ctx.db
      .from('profiles')
      .select('user_id, full_name, email')
      .ilike('email', email)
      .limit(2)

    if (lookupError) {
      console.error('[POST /api/platform/operators] lookup error:', lookupError)
      return NextResponse.json(
        { error: 'Failed to resolve that email' },
        { status: 500 }
      )
    }

    const found = (matches ?? []) as ProfileRow[]
    if (found.length > 1) {
      return NextResponse.json(
        { error: `More than one login uses ${email}. Resolve the duplicate first.` },
        { status: 409 }
      )
    }
    const person = found[0]
    if (!person) {
      return NextResponse.json(
        {
          error: `No login exists for ${email}. They have to sign up first — a platform operator is an existing user promoted, never a new account created from here.`,
        },
        { status: 400 }
      )
    }

    const { data: operator, error } = await ctx.db
      .from('platform_operators')
      .insert({
        user_id: person.user_id,
        role,
        full_name: person.full_name || null,
        note,
        created_by: ctx.userId,
      })
      .select('user_id, role, full_name, note, created_by, created_at, updated_at')
      .single()

    if (error) {
      // user_id is the primary key: a duplicate means they are already
      // on the roster, which is a state to report, not a failure.
      if (error.code === '23505') {
        return NextResponse.json(
          { error: `${email} is already a platform operator.` },
          { status: 409 }
        )
      }
      console.error('[POST /api/platform/operators] insert error:', error)
      return NextResponse.json(
        { error: 'Failed to add the operator' },
        { status: 500 }
      )
    }

    // account_id stays null: this is a platform action, not something
    // done to a customer, so no client's audit view should show it.
    await logPlatformAction(ctx, {
      action: 'OPERATOR_ADDED',
      detail: { user_id: person.user_id, email, role, note },
    })

    return NextResponse.json(
      { operator: { ...operator, email: person.email ?? email } },
      { status: 201 }
    )
  } catch (err) {
    return toPlatformErrorResponse(err)
  }
}
