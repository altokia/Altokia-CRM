// ============================================================
// /api/platform/accounts/[id]/credentials — the keys to a client.
//
//   GET  — who holds them, since when, and whether the client is
//          currently locked out.
//   PUT  — issue a new password for the owner (or for one named
//          member of the account).
//   POST — { action: 'revoke' | 'restore' }: take the platform away
//          from every login in the account, or give it back.
//
// Everything here needs the 'billing' role. Support can read a client's
// health; only the people who answer for the commercial relationship
// get to change who can sign in.
//
// The one rule that shapes the whole file: A PASSWORD IS NEVER WRITTEN
// DOWN. It is generated, sent to Supabase Auth, returned once in the
// response, and forgotten. Not in `accounts`, not in a console log, and
// above all not in `platform_audit_log.detail` — 045 lets the client's
// own admins read that table, so a password in an audit row would be a
// password published to the customer. What the audit records is that a
// password was issued, to whom, and by which operator.
//
// This is operational metadata about the account, not the customer's
// content, so it asks for no consent grant — same line the rest of the
// console draws. Nothing in here reads a conversation or a contact.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

import {
  logPlatformAction,
  requirePlatformOperator,
  toPlatformErrorResponse,
} from '@/lib/platform'
import {
  MIN_PASSWORD_LENGTH,
  adminAuth,
  generatePassword,
  isAcceptablePassword,
  loginUrl,
  resolveBaseUrl,
  setAccountAccess,
} from '@/lib/platform/provisioning'

const MAX_REASON_LEN = 500

const ACCOUNT_SELECT =
  'id, name, owner_user_id, credentials_issued_at, credentials_issued_by, access_revoked_at, access_revoked_by, access_revoked_reason'

interface AccountRow {
  id: string
  name: string
  owner_user_id: string
  credentials_issued_at: string | null
  credentials_issued_by: string | null
  access_revoked_at: string | null
  access_revoked_by: string | null
  access_revoked_reason: string | null
}

interface PersonRow {
  user_id: string
  email: string | null
  full_name: string | null
}

/**
 * The address a login actually signs in with.
 *
 * `profiles.email` is the copy the signup trigger wrote (017), and the
 * only email the service role can read through PostgREST — the `auth`
 * schema is not exposed to it. The admin API is the fallback for the
 * case that copy is missing or stale (a profile deleted by hand, an
 * address changed in the Supabase dashboard), because handing an
 * operator the wrong address to dictate is worse than one extra call.
 */
async function resolveEmail(
  profile: PersonRow | null,
  userId: string
): Promise<string | null> {
  if (profile?.email) return profile.email
  const { data, error } = await adminAuth().auth.admin.getUserById(userId)
  if (error) {
    console.error('[platform/credentials] getUserById failed:', error.message)
    return null
  }
  return data.user?.email ?? null
}

async function loadAccount(
  db: SupabaseClient,
  id: string
): Promise<AccountRow | null> {
  const { data, error } = await db
    .from('accounts')
    .select(ACCOUNT_SELECT)
    .eq('id', id)
    .maybeSingle()
  if (error) {
    console.error('[platform/credentials] account lookup failed:', error)
    throw new Error('account-lookup-failed')
  }
  return (data as AccountRow | null) ?? null
}

// ------------------------------------------------------------
// GET — where the keys are
// ------------------------------------------------------------
/**
 * GET /api/platform/accounts/[id]/credentials
 *
 * The answer to "what happens if I click reset": whose address it goes
 * to, whether Altokia issued these credentials in the first place (so a
 * reset is routine rather than a surprise for a customer who chose
 * their own password), whether the client is locked out and why, and
 * how many people the next revoke would put out of the building.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requirePlatformOperator('billing')
    const { id } = await params

    let account: AccountRow | null
    try {
      account = await loadAccount(ctx.db, id)
    } catch {
      return NextResponse.json({ error: 'Failed to load the account' }, { status: 500 })
    }
    if (!account) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const [ownerResult, memberResult] = await Promise.all([
      ctx.db
        .from('profiles')
        .select('user_id, email, full_name')
        .eq('user_id', account.owner_user_id)
        .maybeSingle(),
      ctx.db
        .from('profiles')
        .select('user_id', { count: 'exact', head: true })
        .eq('account_id', id),
    ])

    if (memberResult.error) {
      console.error('[GET .../credentials] member count failed:', memberResult.error)
    }

    const ownerProfile = (ownerResult.data as PersonRow | null) ?? null
    const ownerEmail = await resolveEmail(ownerProfile, account.owner_user_id)

    // Who at Altokia did each of these things. Best effort: an operator
    // whose profile is gone leaves the id, which is still an answer.
    const operatorIds = [account.credentials_issued_by, account.access_revoked_by].filter(
      (value): value is string => typeof value === 'string' && value.length > 0
    )
    const operatorNames = new Map<string, string>()
    if (operatorIds.length > 0) {
      const { data: operators, error: operatorsError } = await ctx.db
        .from('profiles')
        .select('user_id, email, full_name')
        .in('user_id', operatorIds)
      if (operatorsError) {
        console.error('[GET .../credentials] operator lookup failed:', operatorsError)
      } else {
        for (const row of (operators ?? []) as PersonRow[]) {
          operatorNames.set(row.user_id, row.full_name || row.email || row.user_id)
        }
      }
    }

    return NextResponse.json({
      account_id: account.id,
      owner: {
        user_id: account.owner_user_id,
        email: ownerEmail,
        full_name: ownerProfile?.full_name ?? null,
      },
      credentials: {
        // True when the login was created by Altokia or its password
        // last reset from this console (050's columns).
        issued_by_altokia: account.credentials_issued_at !== null,
        issued_at: account.credentials_issued_at,
        issued_by: account.credentials_issued_by,
        issued_by_name: account.credentials_issued_by
          ? (operatorNames.get(account.credentials_issued_by) ?? null)
          : null,
      },
      access: {
        revoked: account.access_revoked_at !== null,
        revoked_at: account.access_revoked_at,
        revoked_by: account.access_revoked_by,
        revoked_by_name: account.access_revoked_by
          ? (operatorNames.get(account.access_revoked_by) ?? null)
          : null,
        reason: account.access_revoked_reason,
      },
      member_count: memberResult.count ?? 0,
      login_url: loginUrl(resolveBaseUrl(request)),
    })
  } catch (err) {
    return toPlatformErrorResponse(err)
  }
}

// ------------------------------------------------------------
// PUT — issue a password
// ------------------------------------------------------------
/**
 * PUT /api/platform/accounts/[id]/credentials
 *
 * Body: { password?, user_id? }
 *
 * Defaults to the account's owner — the login Altokia sold. `user_id`
 * aims it at one of the client's other people instead, and is checked
 * against `profiles.account_id` first: without that check, the id in
 * the URL would be decoration and this endpoint would reset any
 * password on the platform, including another client's owner.
 *
 * Omitting `password` is the recommended path: the generated one is
 * random, unambiguous to dictate, and nobody has ever typed it into a
 * chat window.
 *
 * The response is the only place the password exists outside Supabase
 * Auth. There is no way to see it again.
 *
 * Changing a password is also what ends the sessions that person has
 * open — GoTrue drops their refresh tokens when an admin sets a new
 * one, and the installed @supabase/auth-js (2.108.2) offers no other
 * admin call that reaches a session: `auth.admin.signOut(jwt)` needs
 * the user's own JWT, which an operator does not have.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requirePlatformOperator('billing')
    const { id } = await params

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    let account: AccountRow | null
    try {
      account = await loadAccount(ctx.db, id)
    } catch {
      return NextResponse.json({ error: 'Failed to load the account' }, { status: 500 })
    }
    if (!account) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // --- who ----------------------------------------------------
    let targetUserId = account.owner_user_id
    if (body.user_id !== undefined && body.user_id !== null) {
      if (typeof body.user_id !== 'string' || !body.user_id.trim()) {
        return NextResponse.json(
          { error: 'user_id must be the id of a person in this account' },
          { status: 400 }
        )
      }
      targetUserId = body.user_id.trim()
    }

    const { data: memberRow, error: memberError } = await ctx.db
      .from('profiles')
      .select('user_id, email, full_name')
      .eq('account_id', id)
      .eq('user_id', targetUserId)
      .maybeSingle()

    if (memberError) {
      console.error('[PUT .../credentials] member lookup failed:', memberError)
      return NextResponse.json(
        { error: 'Failed to check who that person is' },
        { status: 500 }
      )
    }

    // An Altokia operator is not a client to be reset. Without this a
    // 'billing' operator could aim this route at a platform 'owner' who
    // happens to hold a profile in some account, take their password
    // and read it back in clear — a way around the whole platform role
    // hierarchy, from inside the console.
    const { data: targetOperator } = await ctx.db
      .from('platform_operators')
      .select('user_id')
      .eq('user_id', targetUserId)
      .maybeSingle()
    if (targetOperator) {
      return NextResponse.json(
        { error: 'That login belongs to an Altokia operator, not to this client.' },
        { status: 403 }
      )
    }

    const isOwner = targetUserId === account.owner_user_id
    if (!memberRow && !isOwner) {
      // Not "forbidden": from an operator's point of view this person
      // does not exist inside this client.
      return NextResponse.json(
        { error: 'That person is not part of this account' },
        { status: 404 }
      )
    }

    // --- what ---------------------------------------------------
    let password: string
    let passwordGenerated = false
    if (body.password !== undefined && body.password !== null && body.password !== '') {
      if (!isAcceptablePassword(body.password)) {
        return NextResponse.json(
          {
            error: `password must be at least ${MIN_PASSWORD_LENGTH} characters, no longer than 72 bytes, and without leading or trailing spaces`,
          },
          { status: 400 }
        )
      }
      password = body.password as string
    } else {
      password = generatePassword()
      passwordGenerated = true
    }

    const email = await resolveEmail((memberRow as PersonRow | null) ?? null, targetUserId)

    const { error: updateError } = await adminAuth().auth.admin.updateUserById(
      targetUserId,
      { password }
    )
    if (updateError) {
      if (updateError.code === 'user_not_found') {
        return NextResponse.json(
          { error: 'That login no longer exists in Supabase Auth' },
          { status: 404 }
        )
      }
      if (updateError.code === 'weak_password') {
        return NextResponse.json(
          {
            error:
              'Supabase Auth rejected that password as too weak. Leave it blank and one will be generated.',
          },
          { status: 400 }
        )
      }
      console.error(
        '[PUT .../credentials] password update failed:',
        updateError.status,
        updateError.code,
        updateError.message
      )
      return NextResponse.json(
        { error: 'Supabase Auth refused to set the password' },
        { status: 502 }
      )
    }

    // Altokia now holds this account's keys, whoever set it up
    // originally. The stamp is what the console reads to say so, and
    // it is deliberately account-level: the question it answers is
    // "did we issue these credentials", not "for which seat".
    const issuedAt = new Date().toISOString()
    const { error: stampError } = await ctx.db
      .from('accounts')
      .update({ credentials_issued_at: issuedAt, credentials_issued_by: ctx.userId })
      .eq('id', id)
    if (stampError) {
      // The password IS changed; failing the request now would tell the
      // operator to try again and hand the client a password that no
      // longer works. Report the bookkeeping failure in the log only.
      console.error('[PUT .../credentials] issue stamp failed:', stampError)
    }

    await logPlatformAction(ctx, {
      accountId: id,
      action: 'CREDENTIALS_RESET',
      detail: {
        target_user_id: targetUserId,
        // The address, so the client can see whose key was changed.
        // Never the key.
        email,
        is_owner: isOwner,
        password_generated: passwordGenerated,
      },
    })

    return NextResponse.json({
      user_id: targetUserId,
      email,
      password,
      login_url: loginUrl(resolveBaseUrl(request)),
      is_owner: isOwner,
      password_generated: passwordGenerated,
      credentials_issued_at: stampError ? account.credentials_issued_at : issuedAt,
      // A new password does not lift a revocation: the login is still
      // banned and this person still cannot sign in. The console has to
      // say so, or an operator will hand out credentials that do not
      // work and blame the reset.
      access_revoked: account.access_revoked_at !== null,
    })
  } catch (err) {
    return toPlatformErrorResponse(err)
  }
}

// ------------------------------------------------------------
// POST — take the platform away, or give it back
// ------------------------------------------------------------
/**
 * POST /api/platform/accounts/[id]/credentials
 *
 * Body: { action: 'revoke' | 'restore', reason? }
 *
 * Revoking is not suspending. `status = 'suspended'` (PATCH on the
 * client card) is a commercial state the customer can still read their
 * own data in. This is "these people cannot get in", enforced on the
 * auth users themselves.
 *
 * `reason` is required to revoke, because `access_revoked_reason` is
 * the sentence the console shows next to a locked-out client, and
 * "why is this one dark?" needs an answer three months later.
 *
 * ─── Revoking destroys the client's passwords ─────────────────────
 * See `setAccountAccess`: banning a login stops the next sign-in but
 * cannot reach a session already open, and the installed SDK has no
 * admin call that ends one. Rotating every member's password to a
 * random string nobody has seen is what actually ends them, so that is
 * what revoke does. Restoring lifts the ban, but the old passwords are
 * gone for good — the owner needs a fresh one from PUT above, and the
 * client's staff can use the ordinary forgotten-password flow. The
 * response says so with `password_reset_required` rather than leaving
 * the operator to find out from an angry customer.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requirePlatformOperator('billing')
    const { id } = await params

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const action = body.action
    if (action !== 'revoke' && action !== 'restore') {
      return NextResponse.json(
        { error: "action must be 'revoke' or 'restore'" },
        { status: 400 }
      )
    }
    const revoked = action === 'revoke'

    const rawReason = body.reason
    const reason = typeof rawReason === 'string' ? rawReason.trim() : ''
    if (revoked && !reason) {
      return NextResponse.json(
        {
          error:
            'reason is required to revoke access — it is shown next to the locked-out client from then on',
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

    let before: AccountRow | null
    try {
      before = await loadAccount(ctx.db, id)
    } catch {
      return NextResponse.json({ error: 'Failed to load the account' }, { status: 500 })
    }
    if (!before) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    // Throws (and is mapped to a status by toPlatformErrorResponse) if
    // any single login could not be changed — a half-applied revocation
    // must never come back as 200.
    const usersAffected = await setAccountAccess(ctx.db, {
      accountId: id,
      revoked,
      operatorId: ctx.userId,
      reason: revoked ? reason : null,
    })

    let after: AccountRow | null = null
    try {
      after = await loadAccount(ctx.db, id)
    } catch {
      // Cosmetic: the change already happened and was audited.
      after = null
    }

    await logPlatformAction(ctx, {
      accountId: id,
      action: revoked ? 'ACCESS_REVOKED' : 'ACCESS_RESTORED',
      detail: {
        reason: revoked ? reason : (before.access_revoked_reason ?? null),
        users_affected: usersAffected,
        // Says that the passwords were replaced, never with what.
        credentials_invalidated: revoked,
        was_revoked: before.access_revoked_at !== null,
      },
    })

    return NextResponse.json({
      account: {
        id,
        access_revoked_at: after ? after.access_revoked_at : revoked ? new Date().toISOString() : null,
        access_revoked_by: after ? after.access_revoked_by : revoked ? ctx.userId : null,
        access_revoked_reason: after ? after.access_revoked_reason : revoked ? reason : null,
      },
      revoked,
      users_affected: usersAffected,
      // Revoking scrambled every password in the account; restoring
      // cannot undo that. Both flags exist so the console can warn
      // before and explain after.
      credentials_invalidated: revoked,
      password_reset_required: !revoked && before.access_revoked_at !== null,
      login_url: loginUrl(resolveBaseUrl(request)),
    })
  } catch (err) {
    return toPlatformErrorResponse(err)
  }
}
