// ============================================================
// /api/platform/accounts/[id] — one client's card.
//
//   GET   — metadata + health + consumption.
//   PATCH — the commercial half: status, plan, limits, notes.
//
// Still no consent required: every number below is an AGGREGATE or a
// configuration flag ("is the number connected", "how many messages
// last month"), never the content of a message, a contact or a
// knowledge-base entry. The line is deliberate — an operator must be
// able to diagnose a broken customer without asking permission, and
// must NOT be able to read that customer's inbox without it.
// ============================================================

import { NextResponse } from 'next/server'

import {
  PLATFORM_ROLES,
  logPlatformAction,
  requirePlatformOperator,
  toPlatformErrorResponse,
  type PlatformRole,
} from '@/lib/platform'
import { resolveBaseUrl } from '@/lib/platform/provisioning'

const ACCOUNT_STATUSES = ['trial', 'active', 'suspended', 'cancelled'] as const
type AccountStatus = (typeof ACCOUNT_STATUSES)[number]

const ACCOUNT_SELECT =
  'id, name, status, plan, limits, timezone, default_currency, created_at, updated_at, owner_user_id, provisioned_by, provisioned_at, trial_ends_at, suspended_at, suspended_reason, external_ref'

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_PLAN_LEN = 60
const MAX_REF_LEN = 120
const MAX_NOTES_LEN = 4000
const MAX_REASON_LEN = 500

/**
 * PLATFORM_ROLES is declared ascending by power, mirroring 045's enum,
 * so its index IS the hierarchy. Checking here rather than calling
 * `requirePlatformOperator('billing')` a second time keeps the role
 * requirement dependent on what the body actually asks to change,
 * without paying for a second session + roster round trip.
 */
function hasPlatformRole(role: PlatformRole, min: PlatformRole): boolean {
  return PLATFORM_ROLES.indexOf(role) >= PLATFORM_ROLES.indexOf(min)
}

// ------------------------------------------------------------
// GET
// ------------------------------------------------------------
/**
 * GET /api/platform/accounts/[id]
 *
 * ─── Counting messages without an account_id ──────────────────────
 * `messages` has no tenancy column; its tie to an account runs through
 * `conversations.account_id`. Fetching the account's conversation ids
 * and sending them back as an `.in()` list would be two queries and an
 * unbounded id array, so instead the count rides an INNER JOIN that
 * PostgREST builds from the existing FK:
 *
 *   .select('id, conversations!inner(account_id)', { count: 'exact', head: true })
 *   .eq('conversations.account_id', id)
 *
 * `!inner` is what turns the embed into a filterable join, `head: true`
 * means no rows travel — the answer arrives in the Content-Range
 * header. One query, one number, no id list on the wire.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requirePlatformOperator()
    const { id } = await params

    const { data: account, error: accountError } = await ctx.db
      .from('accounts')
      .select(ACCOUNT_SELECT)
      .eq('id', id)
      .maybeSingle()

    if (accountError) {
      console.error('[GET /api/platform/accounts/[id]] fetch error:', accountError)
      return NextResponse.json(
        { error: 'Failed to load the account' },
        { status: 500 }
      )
    }
    if (!account) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const now = Date.now()
    const since30 = new Date(now - 30 * DAY_MS).toISOString()
    const since7 = new Date(now - 7 * DAY_MS).toISOString()
    const nowIso = new Date(now).toISOString()

    const [
      configResult,
      aiConfigResult,
      memberResult,
      contactResult,
      messages30Result,
      inbound7Result,
      aiReplies30Result,
      grantResult,
      activityResult,
      phoneResult,
    ] = await Promise.all([
      ctx.db
        .from('whatsapp_config')
        .select(
          'phone_number_id, waba_id, app_id, status, connected_at, registered_at, subscribed_apps_at, last_registration_error, webhook_token, app_secret, verify_token, updated_at'
        )
        .eq('account_id', id)
        .maybeSingle(),
      ctx.db
        .from('ai_configs')
        .select(
          'provider, model, is_active, auto_reply_enabled, auto_reply_max_per_conversation, updated_at'
        )
        .eq('account_id', id)
        .maybeSingle(),
      ctx.db
        .from('profiles')
        .select('user_id', { count: 'exact', head: true })
        .eq('account_id', id),
      ctx.db
        .from('contacts')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', id),
      ctx.db
        .from('messages')
        .select('id, conversations!inner(account_id)', {
          count: 'exact',
          head: true,
        })
        .eq('conversations.account_id', id)
        .gte('created_at', since30),
      // "Did the webhook deliver anything lately?" — an inbound message
      // is the only thing that can only have arrived through it.
      ctx.db
        .from('messages')
        .select('id, conversations!inner(account_id)', {
          count: 'exact',
          head: true,
        })
        .eq('conversations.account_id', id)
        .eq('sender_type', 'customer')
        .gte('created_at', since7),
      ctx.db
        .from('ai_usage_log')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', id)
        .eq('mode', 'auto_reply')
        .gte('created_at', since30),
      // The asking operator's own standing with this client.
      ctx.db
        .from('platform_access_grants')
        .select(
          'id, status, reason, requested_at, granted_at, revoked_at, expires_at'
        )
        .eq('account_id', id)
        .eq('operator_user_id', ctx.userId)
        .order('requested_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      ctx.db
        .from('conversations')
        .select('last_message_at')
        .eq('account_id', id)
        .not('last_message_at', 'is', null)
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle(),
      // See the roster route: the display number lives nowhere but the
      // audit detail written when an operator connected it.
      ctx.db
        .from('platform_audit_log')
        .select('detail')
        .eq('account_id', id)
        .eq('action', 'WHATSAPP_CONNECTED')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ])

    // Counts are diagnostics, not the payload: a single failing metric
    // must not blank the card an operator is trying to read a customer
    // out of. Each one degrades to null and says so in the log.
    const countOrNull = (
      label: string,
      result: { count: number | null; error: unknown }
    ): number | null => {
      if (result.error) {
        console.error(`[GET /api/platform/accounts/[id]] ${label} failed:`, result.error)
        return null
      }
      return result.count ?? 0
    }

    if (configResult.error) {
      console.error('[GET /api/platform/accounts/[id]] config error:', configResult.error)
    }
    if (aiConfigResult.error) {
      console.error('[GET /api/platform/accounts/[id]] ai_config error:', aiConfigResult.error)
    }

    const config = configResult.data as {
      phone_number_id: string | null
      waba_id: string | null
      app_id: string | null
      status: string | null
      connected_at: string | null
      registered_at: string | null
      subscribed_apps_at: string | null
      last_registration_error: string | null
      webhook_token: string | null
      app_secret: string | null
      verify_token: string | null
      updated_at: string | null
    } | null

    const aiConfig = aiConfigResult.data as {
      provider: string
      model: string
      is_active: boolean
      auto_reply_enabled: boolean
      auto_reply_max_per_conversation: number
      updated_at: string | null
    } | null

    const inbound7 = countOrNull('inbound 7d count', inbound7Result)
    const grant = grantResult.data as {
      id: string
      status: string
      reason: string
      requested_at: string
      granted_at: string | null
      revoked_at: string | null
      expires_at: string
    } | null

    const displayNumber = (phoneResult.data as { detail?: Record<string, unknown> } | null)
      ?.detail?.display_phone_number

    // The internal note lives in its own table since 046. Folding it
    // back onto `account` keeps the console's shape unchanged, and it
    // is safe here: this response only ever reaches an operator.
    const { data: noteRow } = await ctx.db
      .from('platform_account_notes')
      .select('notes')
      .eq('account_id', id)
      .maybeSingle()

    return NextResponse.json({
      account: { ...account, operator_notes: noteRow?.notes ?? null },
      whatsapp: config
        ? {
            connected: config.status === 'connected',
            status: config.status,
            phone_number_id: config.phone_number_id,
            display_phone_number:
              typeof displayNumber === 'string' ? displayNumber : null,
            waba_id: config.waba_id,
            app_id: config.app_id,
            // Whether the client runs its own Meta app, never the secret.
            own_app_secret: config.app_secret !== null,
            connected_at: config.connected_at,
            registered_at: config.registered_at,
            subscribed_apps_at: config.subscribed_apps_at,
            last_registration_error: config.last_registration_error,
            webhook_token: config.webhook_token,
            // The address the operator pastes into Meta. Built here so
            // the ficha can show it whenever it is opened: before this,
            // it existed only in the response to the save that created
            // it, so reopening the client days later left nowhere to
            // read it from and no way to finish the setup.
            webhook_url: config.webhook_token
              ? `${resolveBaseUrl(request)}/api/whatsapp/webhook/${config.webhook_token}`
              : null,
            // Whether Meta's subscription handshake can succeed. The
            // value itself never leaves the server.
            verify_token_set: Boolean(config.verify_token),
            updated_at: config.updated_at,
          }
        : null,
      ai: aiConfig,
      health: {
        // null = the probe itself failed, which is not the same as zero.
        webhook_active_7d: inbound7 === null ? null : inbound7 > 0,
        inbound_messages_7d: inbound7,
        ai_configured: aiConfig !== null,
        ai_auto_reply_on: aiConfig?.auto_reply_enabled ?? false,
        last_activity_at:
          (activityResult.data as { last_message_at: string } | null)
            ?.last_message_at ?? null,
      },
      usage: {
        members: countOrNull('member count', memberResult),
        contacts: countOrNull('contact count', contactResult),
        messages_30d: countOrNull('messages 30d count', messages30Result),
        ai_replies_30d: countOrNull('ai replies 30d count', aiReplies30Result),
      },
      // What the operator asking may currently do here. `active` is the
      // same predicate has_platform_access() applies in SQL, so the
      // console and the enforcement agree.
      support_access: grant
        ? {
            id: grant.id,
            status: grant.status,
            reason: grant.reason,
            requested_at: grant.requested_at,
            granted_at: grant.granted_at,
            revoked_at: grant.revoked_at,
            expires_at: grant.expires_at,
            active: grant.status === 'granted' && grant.expires_at > nowIso,
          }
        : null,
    })
  } catch (err) {
    return toPlatformErrorResponse(err)
  }
}

// ------------------------------------------------------------
// PATCH
// ------------------------------------------------------------
/**
 * PATCH /api/platform/accounts/[id]
 *
 * Body: { status?, plan?, limits?, trial_ends_at?, external_ref?,
 *         operator_notes?, suspended_reason? }
 *
 * Role split, enforced field by field:
 *   * billing+ — anything commercial: status (suspending included),
 *     plan, limits, trial_ends_at, external_ref.
 *   * any operator — operator_notes. Writing down what you saw is not
 *     a commercial decision, and making support ask a manager to leave
 *     a note is how notes stop being written.
 *
 * Suspension is the one transition that demands an explanation: the
 * reason lands in `suspended_reason`, which the client can be shown,
 * and in the audit row, which the client can read.
 */
export async function PATCH(
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

    const patch: Record<string, unknown> = {}

    // --- status -------------------------------------------------
    let nextStatus: AccountStatus | undefined
    if (body.status !== undefined) {
      if (!(ACCOUNT_STATUSES as readonly unknown[]).includes(body.status)) {
        return NextResponse.json(
          { error: `status must be one of ${ACCOUNT_STATUSES.join(', ')}` },
          { status: 400 }
        )
      }
      nextStatus = body.status as AccountStatus
    }

    let suspendedReason: string | null = null
    if (nextStatus === 'suspended') {
      const raw = body.suspended_reason ?? body.reason
      suspendedReason = typeof raw === 'string' ? raw.trim() : ''
      if (!suspendedReason) {
        return NextResponse.json(
          {
            error:
              'suspended_reason is required when suspending — the client is shown this text.',
          },
          { status: 400 }
        )
      }
      if (suspendedReason.length > MAX_REASON_LEN) {
        return NextResponse.json(
          { error: `suspended_reason must be ${MAX_REASON_LEN} characters or fewer` },
          { status: 400 }
        )
      }
    }

    // --- plan ---------------------------------------------------
    if (body.plan !== undefined) {
      if (body.plan === null) {
        patch.plan = null
      } else if (
        typeof body.plan !== 'string' ||
        body.plan.trim().length > MAX_PLAN_LEN
      ) {
        return NextResponse.json(
          { error: `plan must be a string of ${MAX_PLAN_LEN} characters or fewer, or null` },
          { status: 400 }
        )
      } else {
        patch.plan = body.plan.trim() || null
      }
    }

    // --- limits -------------------------------------------------
    if (body.limits !== undefined) {
      // 045 constrains the column to a JSON object; rejecting arrays
      // and scalars here turns a would-be 500 into a readable 400.
      if (
        body.limits === null ||
        typeof body.limits !== 'object' ||
        Array.isArray(body.limits)
      ) {
        return NextResponse.json(
          { error: 'limits must be a JSON object, e.g. {"seats": 5}' },
          { status: 400 }
        )
      }
      patch.limits = body.limits
    }

    // --- trial_ends_at ------------------------------------------
    if (body.trial_ends_at !== undefined) {
      if (body.trial_ends_at === null) {
        patch.trial_ends_at = null
      } else if (
        typeof body.trial_ends_at !== 'string' ||
        Number.isNaN(Date.parse(body.trial_ends_at))
      ) {
        return NextResponse.json(
          { error: 'trial_ends_at must be an ISO 8601 date or null' },
          { status: 400 }
        )
      } else {
        patch.trial_ends_at = body.trial_ends_at
      }
    }

    // --- external_ref -------------------------------------------
    if (body.external_ref !== undefined) {
      if (body.external_ref === null) {
        patch.external_ref = null
      } else if (
        typeof body.external_ref !== 'string' ||
        body.external_ref.trim().length > MAX_REF_LEN
      ) {
        return NextResponse.json(
          { error: `external_ref must be a string of ${MAX_REF_LEN} characters or fewer, or null` },
          { status: 400 }
        )
      } else {
        patch.external_ref = body.external_ref.trim() || null
      }
    }

    // --- operator_notes -----------------------------------------
    // Migration 046 moved these off `accounts`: that table's select
    // policy lets any member read the whole row, so an internal note
    // about a customer was readable by that customer. They live in
    // platform_account_notes now, which has no tenant policy at all.
    let notesTouched = false
    let nextNotes: string | null = null
    if (body.operator_notes !== undefined) {
      if (body.operator_notes === null) {
        nextNotes = null
        notesTouched = true
      } else if (
        typeof body.operator_notes !== 'string' ||
        body.operator_notes.length > MAX_NOTES_LEN
      ) {
        return NextResponse.json(
          { error: `operator_notes must be a string of ${MAX_NOTES_LEN} characters or fewer, or null` },
          { status: 400 }
        )
      } else {
        nextNotes = body.operator_notes
        notesTouched = true
      }
    }

    const commercialFields = Object.keys(patch)
    if (nextStatus !== undefined) commercialFields.push('status')

    if (commercialFields.length === 0 && !notesTouched) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }
    if (commercialFields.length > 0 && !hasPlatformRole(ctx.role, 'billing')) {
      return NextResponse.json(
        {
          error: `Changing ${commercialFields.join(', ')} requires the 'billing' platform role or higher`,
        },
        { status: 403 }
      )
    }

    // Read the current row first: the audit entry has to carry the
    // value that was there before, and a 404 must not be reported as a
    // successful no-op update.
    const { data: before, error: beforeError } = await ctx.db
      .from('accounts')
      .select(ACCOUNT_SELECT)
      .eq('id', id)
      .maybeSingle()

    if (beforeError) {
      console.error('[PATCH /api/platform/accounts/[id]] fetch error:', beforeError)
      return NextResponse.json(
        { error: 'Failed to load the account' },
        { status: 500 }
      )
    }
    if (!before) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    // Suspension bookkeeping. Setting the timestamps here (rather than
    // asking the caller for them) is what keeps `suspended_at` honest.
    if (nextStatus !== undefined) {
      patch.status = nextStatus
      if (nextStatus === 'suspended') {
        patch.suspended_at = new Date().toISOString()
        patch.suspended_reason = suspendedReason
      } else if (before.status === 'suspended') {
        // Reactivating (or cancelling) clears the suspension so nothing
        // downstream keeps reading a stale reason.
        patch.suspended_at = null
        patch.suspended_reason = null
      }
    }

    const { data: after, error: updateError } = await ctx.db
      .from('accounts')
      .update(patch)
      .eq('id', id)
      .select(ACCOUNT_SELECT)
      .maybeSingle()

    if (updateError) {
      console.error('[PATCH /api/platform/accounts/[id]] update error:', updateError)
      return NextResponse.json(
        { error: 'Failed to update the account' },
        { status: 500 }
      )
    }
    if (!after) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    // Internal notes are written after the row update, to their own
    // table, so they never travel through `patch` or the audit detail.
    if (notesTouched) {
      const { error: notesError } = await ctx.db
        .from('platform_account_notes')
        .upsert(
          {
            account_id: id,
            notes: nextNotes ?? '',
            updated_by: ctx.userId,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'account_id' }
        )
      if (notesError) {
        console.error('[PATCH /api/platform/accounts/:id] notes error:', notesError)
        return NextResponse.json(
          { error: 'Failed to save the internal note' },
          { status: 500 }
        )
      }
    }

    // Every field that moved, old value beside new — but the CLIENT
    // reads this log (045), so only fields they are entitled to see
    // carry their values. Anything not on this list is recorded as
    // "changed" without its content, and the list is a whitelist so a
    // column added later cannot leak by omission.
    const PUBLISHABLE = new Set([
      'status',
      'plan',
      'limits',
      'trial_ends_at',
      'suspended_at',
      'suspended_reason',
      'external_ref',
    ])
    const changes: Record<string, unknown> = {}
    const beforeRow = before as Record<string, unknown>
    const afterRow = after as Record<string, unknown>
    for (const key of Object.keys(patch)) {
      if (JSON.stringify(beforeRow[key]) !== JSON.stringify(afterRow[key])) {
        changes[key] = PUBLISHABLE.has(key)
          ? { from: beforeRow[key] ?? null, to: afterRow[key] ?? null }
          : { changed: true }
      }
    }
    if (notesTouched) changes.operator_notes = { changed: true }

    const action =
      nextStatus === undefined || nextStatus === before.status
        ? 'ACCOUNT_UPDATED'
        : nextStatus === 'suspended'
          ? 'ACCOUNT_SUSPENDED'
          : before.status === 'suspended'
            ? 'ACCOUNT_REACTIVATED'
            : 'ACCOUNT_STATUS_CHANGED'

    await logPlatformAction(ctx, {
      accountId: id,
      action,
      detail: { changes },
    })

    return NextResponse.json({ account: after, changes })
  } catch (err) {
    return toPlatformErrorResponse(err)
  }
}
