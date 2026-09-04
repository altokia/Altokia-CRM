// ============================================================
// /api/platform/accounts — the client roster, and the alta.
//
//   GET  — the table Altokia's console opens on: one row per client,
//          with the three things that answer "is this customer OK?"
//          (number connected, people inside, last message).
//   POST — provision a client from nothing: create the owner's login,
//          set its password, and hand both back once.
//
// Both are OPERATIONAL METADATA, so neither asks for consent: an
// operator has to be able to see that a customer is broken without
// first asking that customer for permission. Nothing here reads a
// conversation, a message body, a contact or the knowledge base — the
// moment a route does, it owes a `requirePlatformAccess` call first.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'

import { isValidTimeZone } from '@/lib/availability'
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
} from '@/lib/platform/provisioning'

const ACCOUNT_STATUSES = ['trial', 'active', 'suspended', 'cancelled'] as const

const LIST_SELECT =
  'id, name, status, plan, created_at, provisioned_at, trial_ends_at, suspended_at, external_ref'
const CREATED_SELECT =
  'id, name, status, plan, limits, timezone, created_at, owner_user_id, provisioned_at, provisioned_by, trial_ends_at, external_ref, credentials_issued_at, credentials_issued_by, access_revoked_at'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
const MAX_NAME_LEN = 120
const MAX_PLAN_LEN = 60
const MAX_REF_LEN = 120
const MAX_QUERY_LEN = 100

/**
 * How many conversation rows the "last activity" pass may look at.
 * See the comment on `GET` for what the cap buys and what it costs.
 * Kept at 1.000 so it also stays under any `db-max-rows` PostgREST
 * might be configured with — a server-side truncation would look like
 * an exhausted scan and quietly turn "older than X" into "never".
 */
const ACTIVITY_SCAN_CAP = 1000

/** How far back the display-number lookup reads the audit trail. */
const PHONE_AUDIT_SCAN_CAP = 200

interface AccountRow {
  id: string
  name: string
  status: string
  plan: string | null
  created_at: string
  provisioned_at: string | null
  trial_ends_at: string | null
  suspended_at: string | null
  external_ref: string | null
}

interface ConfigRow {
  account_id: string
  phone_number_id: string | null
  waba_id: string | null
  status: string | null
  connected_at: string | null
  registered_at: string | null
  last_registration_error: string | null
}

// ------------------------------------------------------------
// GET — the roster
// ------------------------------------------------------------
/**
 * GET /api/platform/accounts?q=&status=&limit=&cursor=
 *
 * ─── Why this is four queries and not 4 × N ───────────────────────
 * The naive shape of this endpoint is a loop: for each account, go and
 * fetch its whatsapp_config, count its profiles, find its newest
 * message. At the 1.000-client target that is four thousand round
 * trips and a console that never finishes loading.
 *
 * Instead every column is gathered ONE TABLE AT A TIME for the whole
 * page and joined in memory on `account_id`:
 *
 *   1. accounts            — the page itself (keyset, newest first).
 *   2. whatsapp_config     — `.in('account_id', ids)`, ≤ 1 row each.
 *   3. profiles            — `.in('account_id', ids)`, counted in a Map.
 *   4. conversations       — see below.
 *
 * so the cost is 4 queries per page regardless of page size, and the
 * page size (not the tenant count) bounds the rows on the wire.
 *
 * ─── "Last activity", exactly and cheaply ─────────────────────────
 * The honest definition is `max(messages.created_at)` per account, but
 * messages carries no account_id and PostgREST cannot GROUP BY on this
 * project (aggregate functions are disabled — the server answers
 * PGRST123). `conversations.last_message_at` is the same instant kept
 * denormalised by the inbound trigger (037) and every send path, so
 * the max over it is the max over messages.
 *
 * To get a per-account max without a per-account query, one query asks
 * for the page's conversations newest-first and stops at
 * ACTIVITY_SCAN_CAP rows; the first row seen for an account IS its
 * maximum. An account further down than the cap gets `null` plus a
 * page-level watermark, so the console can say "older than X" instead
 * of pretending the client is dead. When fewer rows than the cap come
 * back the scan was exhaustive and `null` really means "never".
 */
export async function GET(request: Request) {
  try {
    const ctx = await requirePlatformOperator()

    const url = new URL(request.url)
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, MAX_QUERY_LEN)
    const status = url.searchParams.get('status')
    const cursor = url.searchParams.get('cursor')
    const limitParam = url.searchParams.get('limit')

    if (status !== null && !(ACCOUNT_STATUSES as readonly string[]).includes(status)) {
      return NextResponse.json(
        { error: `status must be one of ${ACCOUNT_STATUSES.join(', ')}` },
        { status: 400 }
      )
    }

    let limit = DEFAULT_LIMIT
    if (limitParam !== null) {
      const parsed = Number(limitParam)
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
        return NextResponse.json(
          { error: `limit must be an integer between 1 and ${MAX_LIMIT}` },
          { status: 400 }
        )
      }
      limit = parsed
    }

    if (cursor !== null && Number.isNaN(Date.parse(cursor))) {
      return NextResponse.json(
        { error: 'cursor must be the created_at of the last row you received' },
        { status: 400 }
      )
    }

    let query = ctx.db
      .from('accounts')
      .select(LIST_SELECT, { count: 'exact' })
      .order('created_at', { ascending: false })
      .limit(limit)

    if (q) query = query.ilike('name', `%${q}%`)
    if (status) query = query.eq('status', status)
    // Keyset, not offset: a client provisioned while the operator pages
    // must not shift the rows underneath them. created_at is NOT NULL
    // with microsecond resolution, so it orders the table on its own.
    if (cursor) query = query.lt('created_at', cursor)

    const { data, error, count } = await query
    if (error) {
      console.error('[GET /api/platform/accounts] fetch error:', error)
      return NextResponse.json(
        { error: 'Failed to load accounts' },
        { status: 500 }
      )
    }

    const accounts = (data ?? []) as AccountRow[]
    if (accounts.length === 0) {
      return NextResponse.json({
        accounts: [],
        total: count ?? 0,
        next_cursor: null,
        last_activity_complete: true,
        last_activity_watermark: null,
      })
    }

    const ids = accounts.map((a) => a.id)

    const [configResult, memberResult, activityResult, phoneResult] =
      await Promise.all([
        ctx.db
          .from('whatsapp_config')
          .select(
            'account_id, phone_number_id, waba_id, status, connected_at, registered_at, last_registration_error'
          )
          .in('account_id', ids),
        // Just the key: the count is done here, not by the database,
        // because PostgREST cannot return a grouped count and one
        // count-query per account is exactly what this route refuses
        // to do. A page of 50 accounts is a few hundred rows.
        ctx.db.from('profiles').select('account_id').in('account_id', ids),
        ctx.db
          .from('conversations')
          .select('account_id, last_message_at')
          .in('account_id', ids)
          .not('last_message_at', 'is', null)
          .order('last_message_at', { ascending: false, nullsFirst: false })
          .limit(ACTIVITY_SCAN_CAP),
        // 045 gave whatsapp_config no display_phone_number column, and
        // Meta only tells us the human-readable number at verify time.
        // PUT …/[id]/whatsapp records it in the audit detail, so the
        // newest WHATSAPP_CONNECTED entry is where it survives. Best
        // effort: a client who connected their own number through the
        // tenant settings screen leaves no entry, and the column shows
        // blank rather than wrong.
        ctx.db
          .from('platform_audit_log')
          .select('account_id, detail')
          .in('account_id', ids)
          .eq('action', 'WHATSAPP_CONNECTED')
          .order('created_at', { ascending: false })
          .limit(PHONE_AUDIT_SCAN_CAP),
      ])

    if (configResult.error || memberResult.error || activityResult.error) {
      console.error(
        '[GET /api/platform/accounts] enrichment error:',
        configResult.error ?? memberResult.error ?? activityResult.error
      )
      return NextResponse.json(
        { error: 'Failed to load account health' },
        { status: 500 }
      )
    }

    const configByAccount = new Map<string, ConfigRow>()
    for (const row of (configResult.data ?? []) as ConfigRow[]) {
      configByAccount.set(row.account_id, row)
    }

    const memberCount = new Map<string, number>()
    for (const row of (memberResult.data ?? []) as { account_id: string }[]) {
      memberCount.set(row.account_id, (memberCount.get(row.account_id) ?? 0) + 1)
    }

    const activityRows = (activityResult.data ?? []) as {
      account_id: string
      last_message_at: string
    }[]
    const lastActivity = new Map<string, string>()
    for (const row of activityRows) {
      // Rows arrive newest-first, so the first one per account is that
      // account's maximum and every later row can be skipped.
      if (!lastActivity.has(row.account_id)) {
        lastActivity.set(row.account_id, row.last_message_at)
      }
    }
    const activityComplete = activityRows.length < ACTIVITY_SCAN_CAP
    const activityWatermark = activityComplete
      ? null
      : (activityRows[activityRows.length - 1]?.last_message_at ?? null)

    const displayNumber = new Map<string, string>()
    if (phoneResult.error) {
      // Cosmetic only — never worth failing the roster over.
      console.warn(
        '[GET /api/platform/accounts] display-number lookup failed:',
        phoneResult.error
      )
    } else {
      for (const row of (phoneResult.data ?? []) as {
        account_id: string
        detail: Record<string, unknown> | null
      }[]) {
        const value = row.detail?.display_phone_number
        if (typeof value === 'string' && !displayNumber.has(row.account_id)) {
          displayNumber.set(row.account_id, value)
        }
      }
    }

    const rows = accounts.map((account) => {
      const config = configByAccount.get(account.id) ?? null
      return {
        id: account.id,
        name: account.name,
        status: account.status,
        plan: account.plan,
        created_at: account.created_at,
        provisioned_at: account.provisioned_at,
        trial_ends_at: account.trial_ends_at,
        suspended_at: account.suspended_at,
        external_ref: account.external_ref,
        whatsapp: config
          ? {
              connected: config.status === 'connected',
              phone_number_id: config.phone_number_id,
              display_phone_number: displayNumber.get(account.id) ?? null,
              waba_id: config.waba_id,
              status: config.status,
              connected_at: config.connected_at,
              registered_at: config.registered_at,
              last_registration_error: config.last_registration_error,
            }
          : null,
        member_count: memberCount.get(account.id) ?? 0,
        last_activity_at: lastActivity.get(account.id) ?? null,
      }
    })

    return NextResponse.json({
      accounts: rows,
      total: count ?? rows.length,
      next_cursor:
        accounts.length === limit
          ? accounts[accounts.length - 1].created_at
          : null,
      // Both flags describe `last_activity_at` only; see the doc block.
      last_activity_complete: activityComplete,
      last_activity_watermark: activityWatermark,
    })
  } catch (err) {
    return toPlatformErrorResponse(err)
  }
}

// ------------------------------------------------------------
// POST — the alta, in the cold
// ------------------------------------------------------------
/**
 * How long to wait for `handle_new_user` to land the workspace.
 *
 * The trigger runs inside the same transaction as the INSERT into
 * `auth.users`, so in the normal case the first read already finds it
 * and no delay is paid at all. The retries exist for the two ways that
 * stops being true: a read that lands on a replica a moment behind, and
 * a trigger that swallowed its own failure — 017 ends with
 * `EXCEPTION WHEN OTHERS THEN RAISE WARNING`, so a broken bootstrap
 * looks exactly like a slow one from out here. That is precisely why a
 * failed poll deletes the login instead of shrugging.
 */
const ACCOUNT_POLL_DELAYS_MS = [0, 120, 250, 500, 900]

async function findWorkspaceFor(
  db: SupabaseClient,
  ownerUserId: string
): Promise<string | null> {
  for (const delay of ACCOUNT_POLL_DELAYS_MS) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    const { data, error } = await db
      .from('accounts')
      .select('id')
      .eq('owner_user_id', ownerUserId)
      .maybeSingle()
    if (error) {
      console.error('[POST /api/platform/accounts] workspace poll error:', error)
      continue
    }
    if (data?.id) return data.id as string
  }
  return null
}

/**
 * POST /api/platform/accounts
 *
 * Body: { name, owner_email, owner_name?, password?, plan?, status?,
 *         timezone?, external_ref?, trial_ends_at? }
 *
 * ─── The alta is cold now ─────────────────────────────────────────
 * This endpoint used to require that the customer had already signed
 * up: it looked their login up by email and *claimed* the empty
 * workspace their signup had produced. That is backwards for a business
 * that sells a service and hands over the keys — it made the customer
 * do the one step that decides who controls the credentials, and it
 * meant Altokia never knew the password it was supposed to be able to
 * reset.
 *
 * So the route creates the login itself:
 *
 *   1. `auth.admin.createUser` with `email_confirm: true` — the client
 *      confirms nothing, because the person handing them the password
 *      is the one who already knows the address is right.
 *   2. `handle_new_user` (017) fires on that insert exactly as it fires
 *      on a self-signup, and produces the `accounts` row plus an owner
 *      `profiles` row. This is why `accounts.owner_user_id` being NOT
 *      NULL with a unique index (017, locked) was never the obstacle it
 *      looked like: the constraint wants a login to exist first, not a
 *      *signup* to have happened first.
 *   3. The workspace it made is then dressed as a customer: real
 *      business name, plan, status, billing reference, and the two
 *      stamps that say Altokia issued the keys.
 *
 * If step 2 does not produce a workspace, step 1 is undone. A login
 * with no account is a customer who can sign in to nothing and an email
 * address that can never be provisioned again, which is a far worse
 * outcome than an error the operator can retry.
 *
 * ─── The password ─────────────────────────────────────────────────
 * Returned exactly once, in this response, and never stored anywhere by
 * us — not in `accounts`, not in the audit trail (the customer's own
 * admins can read that table, 045), not in a log line. If it is lost
 * before it reaches the client, the answer is
 * `PUT /api/platform/accounts/[id]/credentials`, which mints a new one.
 *
 * An existing email is a 409 and nothing else: taking over a login that
 * already exists would mean an operator could point an email they do
 * not control at a workspace, or silently reset a real customer's
 * password while "creating" somebody else.
 */
export async function POST(request: Request) {
  try {
    // Creating a login, setting a plan and issuing credentials are all
    // commercial acts — the same ones PATCH reserves to 'billing'.
    const ctx = await requirePlatformOperator('billing')

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    // --- the business ------------------------------------------
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name || name.length > MAX_NAME_LEN) {
      return NextResponse.json(
        { error: `name is required and must be ${MAX_NAME_LEN} characters or fewer` },
        { status: 400 }
      )
    }

    // --- the owner ---------------------------------------------
    const ownerEmail =
      typeof body.owner_email === 'string' ? body.owner_email.trim().toLowerCase() : ''
    if (!ownerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
      return NextResponse.json(
        { error: 'owner_email must be a valid email address' },
        { status: 400 }
      )
    }

    let ownerName = ''
    if (body.owner_name !== undefined && body.owner_name !== null) {
      if (typeof body.owner_name !== 'string' || body.owner_name.trim().length > MAX_NAME_LEN) {
        return NextResponse.json(
          { error: `owner_name must be a string of ${MAX_NAME_LEN} characters or fewer` },
          { status: 400 }
        )
      }
      ownerName = body.owner_name.trim()
    }

    // --- the password ------------------------------------------
    // An operator may bring their own (a client who insists on one they
    // will remember); otherwise the generator wins, and it should.
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

    // --- status -------------------------------------------------
    // Only the two states a brand-new customer can legitimately be in.
    // Suspending or cancelling is a later, audited decision (PATCH).
    const status = body.status === undefined ? 'trial' : body.status
    if (status !== 'trial' && status !== 'active') {
      return NextResponse.json(
        { error: "status must be 'trial' or 'active' when provisioning" },
        { status: 400 }
      )
    }

    // --- plan ---------------------------------------------------
    // 050 made `accounts.plan` a foreign key into `platform_plans`, so
    // an unknown code is now a constraint violation. Checking it here
    // turns a 500 with a Postgres message into a 400 that names the
    // catalogue, and rejects a plan that has been retired.
    let plan: string | null = null
    if (body.plan !== undefined && body.plan !== null && body.plan !== '') {
      if (typeof body.plan !== 'string' || body.plan.trim().length > MAX_PLAN_LEN) {
        return NextResponse.json(
          { error: `plan must be a string of ${MAX_PLAN_LEN} characters or fewer` },
          { status: 400 }
        )
      }
      const code = body.plan.trim()
      const { data: planRow, error: planError } = await ctx.db
        .from('platform_plans')
        .select('code, is_active')
        .eq('code', code)
        .maybeSingle()

      if (planError) {
        console.error('[POST /api/platform/accounts] plan lookup error:', planError)
        return NextResponse.json({ error: 'Failed to check the plan' }, { status: 500 })
      }
      if (!planRow) {
        return NextResponse.json(
          { error: `plan '${code}' is not in the catalogue — GET /api/platform/plans lists the codes` },
          { status: 400 }
        )
      }
      if (!planRow.is_active) {
        return NextResponse.json(
          { error: `plan '${code}' is no longer offered` },
          { status: 400 }
        )
      }
      plan = planRow.code as string
    }

    // --- the rest -----------------------------------------------
    let externalRef: string | null = null
    if (body.external_ref !== undefined && body.external_ref !== null) {
      if (
        typeof body.external_ref !== 'string' ||
        body.external_ref.trim().length > MAX_REF_LEN
      ) {
        return NextResponse.json(
          { error: `external_ref must be a string of ${MAX_REF_LEN} characters or fewer` },
          { status: 400 }
        )
      }
      externalRef = body.external_ref.trim() || null
    }

    let timezone: string | undefined
    if (body.timezone !== undefined && body.timezone !== null) {
      if (typeof body.timezone !== 'string' || !isValidTimeZone(body.timezone)) {
        return NextResponse.json(
          { error: 'timezone must be a valid IANA time zone' },
          { status: 400 }
        )
      }
      timezone = body.timezone
    }

    let trialEndsAt: string | null = null
    if (body.trial_ends_at !== undefined && body.trial_ends_at !== null) {
      if (
        typeof body.trial_ends_at !== 'string' ||
        Number.isNaN(Date.parse(body.trial_ends_at))
      ) {
        return NextResponse.json(
          { error: 'trial_ends_at must be an ISO 8601 date' },
          { status: 400 }
        )
      }
      trialEndsAt = body.trial_ends_at
    }

    const baseUrl = resolveBaseUrl(request)

    // 1. Is this address already somebody's login? `profiles.email` is
    //    written from auth.users by the signup trigger and is the only
    //    place the service role can read an address through PostgREST
    //    (the auth schema is not exposed). Asking first turns the common
    //    mistake — provisioning the same client twice — into a clear
    //    409 that names the account, instead of a bare "email exists"
    //    from GoTrue.
    const { data: existing, error: existingError } = await ctx.db
      .from('profiles')
      .select('user_id, account_id')
      .ilike('email', ownerEmail)
      .limit(1)

    if (existingError) {
      console.error('[POST /api/platform/accounts] email lookup error:', existingError)
      return NextResponse.json(
        { error: 'Failed to check whether that email is already in use' },
        { status: 500 }
      )
    }
    if (existing && existing.length > 0) {
      return NextResponse.json(
        {
          error: `${ownerEmail} already has a login on this platform. Provisioning would take it over, so it is refused — use a different address, or reset the password of the existing account.`,
          account_id: (existing[0] as { account_id: string | null }).account_id,
        },
        { status: 409 }
      )
    }

    // 2. Create the login. `email_confirm: true` because there is no
    //    confirmation to do: the operator is handing this person their
    //    password directly, and an unconfirmed address would just mean
    //    a client who cannot sign in until they find an email.
    const auth = adminAuth().auth.admin
    const { data: created, error: createError } = await auth.createUser({
      email: ownerEmail,
      password,
      email_confirm: true,
      // handle_new_user reads exactly this key (017). Falling back to
      // the business name keeps `profiles.full_name` from being blank
      // for a person nobody has met yet.
      user_metadata: { full_name: ownerName || name },
    })

    if (createError || !created?.user) {
      const code = createError?.code
      if (
        code === 'email_exists' ||
        code === 'user_already_exists' ||
        /already (been )?registered|already exists/i.test(createError?.message ?? '')
      ) {
        // The check above raced, or the address exists in auth.users
        // without a profile row.
        return NextResponse.json(
          { error: `${ownerEmail} already has a login on this platform.` },
          { status: 409 }
        )
      }
      if (code === 'weak_password') {
        return NextResponse.json(
          { error: 'Supabase Auth rejected that password as too weak. Leave it blank and one will be generated.' },
          { status: 400 }
        )
      }
      console.error(
        '[POST /api/platform/accounts] createUser failed:',
        createError?.status,
        code,
        createError?.message
      )
      return NextResponse.json(
        { error: 'Supabase Auth refused to create the login' },
        { status: 502 }
      )
    }

    const ownerUserId = created.user.id

    // 3. The workspace the trigger should have made.
    const accountId = await findWorkspaceFor(ctx.db, ownerUserId)
    if (!accountId) {
      // Undo the login rather than leave an address that can never be
      // provisioned again attached to nothing.
      const { error: cleanupError } = await auth.deleteUser(ownerUserId)
      if (cleanupError) {
        console.error(
          '[POST /api/platform/accounts] orphan cleanup failed for',
          ownerUserId,
          cleanupError.message
        )
      }
      return NextResponse.json(
        {
          error: cleanupError
            ? `The login was created but no workspace appeared for it (the handle_new_user trigger did not run), and the login could not be removed. A support engineer has to delete the auth user ${ownerUserId} before ${ownerEmail} can be provisioned again.`
            : 'The login was created but no workspace appeared for it (the handle_new_user trigger did not run). The login has been removed — nothing was left behind, so this can be retried.',
        },
        { status: 500 }
      )
    }

    // 4. Dress the workspace as a customer. `credentials_issued_*` (050)
    //    is what later tells the console that resetting this client's
    //    password is routine rather than a surprise.
    const issuedAt = new Date().toISOString()
    const { data: account, error: updateError } = await ctx.db
      .from('accounts')
      .update({
        name,
        status,
        plan,
        external_ref: externalRef,
        trial_ends_at: trialEndsAt,
        provisioned_by: ctx.userId,
        provisioned_at: issuedAt,
        credentials_issued_by: ctx.userId,
        credentials_issued_at: issuedAt,
        ...(timezone !== undefined ? { timezone } : {}),
      })
      .eq('id', accountId)
      .select(CREATED_SELECT)
      .single()

    if (updateError || !account) {
      // The login and the workspace both exist and work; only the
      // commercial fields failed. Deleting them here would be worse
      // than reporting it — `accounts.owner_user_id` is ON DELETE
      // RESTRICT, so the login cannot be removed without dismantling
      // the workspace first, and the operator can finish this by hand.
      console.error('[POST /api/platform/accounts] account update error:', updateError)
      return NextResponse.json(
        {
          error:
            'The login and workspace were created, but the account details could not be saved. Set the name and plan from the client card, and issue a fresh password there — the one from this request was not returned.',
          account_id: accountId,
          owner_user_id: ownerUserId,
        },
        { status: 500 }
      )
    }

    await logPlatformAction(ctx, {
      accountId,
      action: 'ACCOUNT_PROVISIONED',
      detail: {
        name,
        owner_email: ownerEmail,
        owner_user_id: ownerUserId,
        status,
        plan,
        external_ref: externalRef,
        // That a password was issued is the record. What it was is not
        // written down anywhere — this row is readable by the client.
        credentials_issued: true,
        password_generated: passwordGenerated,
      },
    })

    return NextResponse.json(
      {
        account,
        owner: {
          user_id: ownerUserId,
          email: ownerEmail,
          full_name: ownerName || name,
        },
        // The one and only time this password is readable. There is no
        // endpoint that can show it again, by design.
        credentials: {
          email: ownerEmail,
          password,
          login_url: loginUrl(baseUrl),
        },
        password_generated: passwordGenerated,
      },
      { status: 201 }
    )
  } catch (err) {
    return toPlatformErrorResponse(err)
  }
}
