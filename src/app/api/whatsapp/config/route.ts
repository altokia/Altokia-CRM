// ============================================================
// /api/whatsapp/config — the connection behind a customer's WhatsApp.
//
// Altokia connects the number, not the customer: the Meta Cloud API
// side of it is technical work done with the client on the phone, and
// the credentials it stores are ours to hold. So the two handlers that
// WRITE (POST) or REMOVE (DELETE) the connection now demand a platform
// operator — a customer admin who found this URL gets the same 404 the
// console gives anyone who is not staff.
//
// The canonical way to connect a client is
// PUT /api/platform/accounts/[id]/whatsapp, which takes the account as
// a parameter, mints the per-client webhook address and audits the
// change. These two stay because they are the only path that also
// runs Meta's /register with a 2FA PIN, which the platform route does
// not do — but they act on the CALLER's own account, so an operator
// using them is repairing an account they themselves belong to.
//
// GET stays open to the customer. It is the one honest question they
// can ask about infrastructure they do not own ("is my WhatsApp
// working?"), and it answers with booleans, never with credentials.
// ============================================================

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import {
  logPlatformAction,
  requirePlatformOperator,
  toPlatformErrorResponse,
} from '@/lib/platform'
import {
  registerPhoneNumber,
  subscribeWabaToApp,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'

/**
 * Resolve the caller's account_id from their profile. Inlined here
 * (rather than going through `@/lib/auth/account.getCurrentAccount`)
 * because the GET handler wants to return shaped 200s for every
 * non-auth failure mode, not throw — keeping the helper minimal lets
 * the existing response branches stay as-is.
 *
 * Returns null if the user has no profile or no account; callers
 * should treat that the same as "not connected".
 */
async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data?.account_id) return null
  return data.account_id as string
}

// Lazy-initialised service-role client. We need it to detect a
// phone_number_id already claimed by a *different* user — under RLS,
// the user's own session can't see other users' rows, so the conflict
// would be invisible without the service role.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

/**
 * GET /api/whatsapp/config
 *
 * The half of this route a customer may still call, and it answers
 * exactly one question: is my WhatsApp working? Since they can no
 * longer act on the answer, the answer is two booleans plus the number
 * Meta shows on the outside — which the customer already reads at the
 * top of every conversation.
 *
 * Deliberately gone from the payload: the failure `reason`, the
 * `needs_reset` flag, the copy naming ENCRYPTION_KEY, and Meta's own
 * error text. Those described our storage to someone who does not run
 * it, and offered a repair they are no longer allowed to perform. The
 * diagnostic detail now lives where the person who can act on it is:
 * the operator console's health card and registration probe.
 *
 * Still 200 in every non-auth case, so the settings landing can render
 * a status line instead of an error.
 *
 * Response shape:
 *   { configured: boolean, connected: boolean,
 *     phone_number: string | null, verified_name: string | null }
 */
export async function GET() {
  // Nothing configured, nothing reachable — the shape callers get for
  // every negative answer, so none of them can tell "no row" from
  // "Meta refused the token". Only the operator needs that difference.
  const NOT_CONNECTED = {
    configured: false,
    connected: false,
    phone_number: null as string | null,
    verified_name: null as string | null,
  }

  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(NOT_CONNECTED, { status: 200 })
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('phone_number_id, access_token, status')
      .eq('account_id', accountId)
      .maybeSingle()

    if (configError) {
      console.error('Error fetching whatsapp_config:', configError)
      return NextResponse.json(NOT_CONNECTED, { status: 200 })
    }

    if (!config) {
      return NextResponse.json(NOT_CONNECTED, { status: 200 })
    }

    // From here on the row exists, so `configured` is true no matter
    // how the health check goes: "Altokia set this up and it is
    // currently unhealthy" is a different message to the customer than
    // "nobody has set this up yet".
    const configured = { ...NOT_CONNECTED, configured: true }

    let accessToken: string
    try {
      accessToken = decrypt(config.access_token)
    } catch (err) {
      // Server-side only. The customer cannot rotate ENCRYPTION_KEY and
      // cannot re-enter the token, so telling them which one broke buys
      // nothing but a support ticket with our internals in it.
      console.error('[whatsapp/config GET] Token decryption failed:', err)
      return NextResponse.json(configured, { status: 200 })
    }

    try {
      const phoneInfo = await verifyPhoneNumber({
        phoneNumberId: config.phone_number_id,
        accessToken,
      })
      return NextResponse.json({
        configured: true,
        connected: true,
        phone_number: phoneInfo.display_phone_number ?? null,
        verified_name: phoneInfo.verified_name ?? null,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error'
      console.error('[whatsapp/config GET] Meta API verification failed:', message)
      return NextResponse.json(configured, { status: 200 })
    }
  } catch (error) {
    console.error('Error in WhatsApp config GET:', error)
    return NextResponse.json(NOT_CONNECTED, { status: 500 })
  }
}

/**
 * POST /api/whatsapp/config — STAFF ONLY.
 *
 * Saves or updates the WhatsApp connection of the CALLER's own
 * account. Verifies the credentials with Meta first, then encrypts and
 * stores them.
 *
 * The operator gate is what closes it to customers, and it closes it
 * fairly hard: operators are deliberately members of no customer
 * account (045 keeps the two planes disjoint), so on production a
 * customer gets the console's 404 and an operator gets "not linked to
 * an account". That is the intent — the live path for connecting a
 * client is PUT /api/platform/accounts/[id]/whatsapp, which names the
 * account explicitly and mints that client's webhook address.
 *
 * The handler is kept working rather than turned into a 410 because it
 * is still the only implementation of Meta's /register + two-step PIN
 * step, which the platform route does not perform yet.
 */
export async function POST(request: Request) {
  try {
    // Throws PlatformAuthError (404 for non-staff, 403 for too junior);
    // the catch below turns it into the response.
    const ctx = await requirePlatformOperator()

    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const body = await request.json()
    const { phone_number_id, waba_id, access_token, verify_token, pin } = body

    if (!access_token || !phone_number_id) {
      return NextResponse.json(
        { error: 'access_token and phone_number_id are required' },
        { status: 400 }
      )
    }

    if (pin !== undefined && pin !== null && pin !== '') {
      if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
        return NextResponse.json(
          { error: 'PIN must be exactly 6 digits.' },
          { status: 400 }
        )
      }
    }

    // Reject if another account has already claimed this phone_number_id.
    // wacrm is single-tenant-per-WhatsApp-number — letting two accounts
    // bind the same number causes the webhook's `.single()` lookup to
    // throw PGRST116 ("multiple rows"), silently dropping every
    // inbound message. See issue #136. Post-multi-user we key on
    // account_id (not user_id) since teammates inside the same account
    // all share one config; the conflict is between accounts.
    const { data: claimed, error: claimedError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id')
      .eq('phone_number_id', phone_number_id)
      .neq('account_id', accountId)
      .maybeSingle()

    if (claimedError) {
      console.error('Error checking phone_number_id ownership:', claimedError)
      return NextResponse.json(
        { error: 'Failed to validate configuration' },
        { status: 500 }
      )
    }

    if (claimed) {
      return NextResponse.json(
        {
          error:
            'This WhatsApp phone number is already linked to another account on this instance. Each phone number can only be connected to one wacrm user.',
        },
        { status: 409 }
      )
    }

    // Verify credentials with Meta BEFORE saving
    let phoneInfo
    try {
      phoneInfo = await verifyPhoneNumber({
        phoneNumberId: phone_number_id,
        accessToken: access_token,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error'
      console.error('Meta API verification failed during save:', message)
      return NextResponse.json(
        { error: `Meta API error: ${message}` },
        { status: 400 }
      )
    }

    // Encrypt sensitive tokens before storing
    let encryptedAccessToken: string
    let encryptedVerifyToken: string | null
    try {
      encryptedAccessToken = encrypt(access_token)
      encryptedVerifyToken = verify_token ? encrypt(verify_token) : null
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown encryption error'
      console.error('Encryption failed:', message)
      return NextResponse.json(
        {
          error:
            'Failed to encrypt token. Check that ENCRYPTION_KEY is a valid 64-character hex string in your environment variables.',
        },
        { status: 500 }
      )
    }

    // Look up any pre-existing row for this account so we know whether
    // this number is already registered with Meta — if so we can skip
    // /register when the user didn't provide a PIN this time around.
    const { data: existing } = await supabase
      .from('whatsapp_config')
      .select('id, registered_at, phone_number_id')
      .eq('account_id', accountId)
      .maybeSingle()

    const sameNumber =
      existing?.phone_number_id === phone_number_id &&
      existing?.registered_at != null

    // Step 1: register the phone number for inbound webhooks.
    //
    // Attempted on first save AND whenever the user supplies a fresh
    // PIN (e.g. they rotated the 2FA PIN in Meta Manager). Skipped
    // when the same number is already registered and no PIN was
    // supplied — re-registering an already-active number with a
    // stale PIN would actually fail and undo the active subscription.
    let registeredAt: string | null = existing?.registered_at ?? null
    let registrationError: string | null = null
    // True when registration was deliberately skipped because no PIN
    // was supplied (see below). Distinct from registrationError — this
    // is not a failure, just an incomplete-but-valid save.
    let registrationSkipped = false

    const needsRegistration = !sameNumber || (typeof pin === 'string' && pin.length > 0)
    if (needsRegistration) {
      if (!pin) {
        // No PIN provided. Meta TEST numbers (Developer Console) are
        // pre-registered by Meta and expose no two-step verification
        // PIN to set, so requiring one made them impossible to connect
        // (issue #242). The /register + PIN step only matters for
        // production numbers under a shared WABA (issue #136), so treat
        // it as best-effort: skip it, save the (already Meta-verified)
        // credentials as connected, and leave registered_at null. The
        // UI surfaces a separate "Not registered" banner with a path to
        // add a PIN later for users who do need inbound webhook routing.
        registrationSkipped = true
      } else {
        try {
          await registerPhoneNumber({
            phoneNumberId: phone_number_id,
            accessToken: access_token,
            pin,
          })
          registeredAt = new Date().toISOString()
        } catch (err) {
          registrationError =
            err instanceof Error ? err.message : 'Unknown Meta API error'
          console.error('Phone number /register failed:', registrationError)
          // We deliberately fall through and still save the row so the
          // user can retry without re-entering everything. The UI
          // surfaces `last_registration_error` so they see WHY it's
          // not actually live yet.
        }
      }
    }

    // Step 2: subscribe the WABA to this app. Idempotent on Meta's
    // side, so we call on every save and persist the timestamp.
    // Skipped only when there's no waba_id (legacy rows from before
    // we required it).
    let subscribedAppsAt: string | null = null
    if (waba_id) {
      try {
        await subscribeWabaToApp({
          wabaId: waba_id,
          accessToken: access_token,
        })
        subscribedAppsAt = new Date().toISOString()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.warn('WABA subscribed_apps failed (non-fatal):', message)
        // Subscription failures are rare once the App has the right
        // permissions; we don't block save on them — the diagnostic
        // endpoint surfaces this state too.
      }
    }

    // Persist everything in one shot. If /register failed we still
    // store the credentials and the error so the UI can guide the
    // user through a retry.
    const baseRow = {
      phone_number_id,
      waba_id: waba_id || null,
      access_token: encryptedAccessToken,
      verify_token: encryptedVerifyToken,
      status: registrationError ? 'disconnected' : 'connected',
      connected_at: registrationError ? null : new Date().toISOString(),
      registered_at: registrationError ? null : registeredAt,
      subscribed_apps_at: subscribedAppsAt ?? null,
      last_registration_error: registrationError,
      updated_at: new Date().toISOString(),
    }

    if (existing) {
      const { error: updateError } = await supabase
        .from('whatsapp_config')
        .update(baseRow)
        .eq('account_id', accountId)

      if (updateError) {
        console.error('Error updating whatsapp_config:', updateError)
        return NextResponse.json(
          { error: 'Failed to update configuration' },
          { status: 500 }
        )
      }
    } else {
      // Insert with both columns: `account_id` is the tenancy key
      // (NOT NULL post-017, UNIQUE so duplicates trip the constraint
      // up-front), `user_id` is the audit column identifying which
      // member of the account saved the config.
      const { error: insertError } = await supabase
        .from('whatsapp_config')
        .insert({
          account_id: accountId,
          user_id: user.id,
          ...baseRow,
        })

      if (insertError) {
        console.error('Error inserting whatsapp_config:', insertError)
        return NextResponse.json(
          { error: 'Failed to save configuration' },
          { status: 500 }
        )
      }
    }

    // Same rule as the platform plane: flags and identifiers, never
    // the token. The customer can read this log (045).
    await logPlatformAction(ctx, {
      accountId,
      action: 'WHATSAPP_CONNECTED',
      detail: {
        phone_number_id,
        waba_id: waba_id || null,
        registered: registeredAt != null,
        registration_error: registrationError,
        via: 'tenant_config_route',
      },
    })

    if (registrationError) {
      // Save succeeded but the number isn't actually live. Return
      // 200 with a structured error so the UI can show the specific
      // remediation step instead of a generic toast.
      return NextResponse.json({
        success: false,
        saved: true,
        registered: false,
        registration_error: registrationError,
        phone_info: phoneInfo,
      })
    }

    return NextResponse.json({
      success: true,
      saved: true,
      registered: registeredAt != null,
      // Credentials are valid and saved, but inbound webhook
      // registration was skipped because no PIN was supplied (e.g. a
      // Meta test number). The UI shows the "Not registered" banner
      // rather than claiming the number is fully live.
      registration_skipped: registrationSkipped,
      phone_info: phoneInfo,
    })
  } catch (error) {
    // Also the exit for a refused operator check — toPlatformErrorResponse
    // preserves its 404/403 instead of flattening it to a 500.
    return toPlatformErrorResponse(error)
  }
}

/**
 * DELETE /api/whatsapp/config — STAFF ONLY, billing and up.
 *
 * Drops the caller's own WhatsApp configuration row. Same gate and
 * same reasoning as POST above, one notch stricter: deleting the row
 * takes the number offline AND discards `webhook_token`, so whoever
 * reconnects has to paste a fresh webhook address into Meta. That is
 * not something a curious customer admin should be able to do to their
 * own company by clicking around in settings — which is precisely what
 * the old "Reset Configuration" button let them do.
 *
 * Disconnecting a CLIENT is DELETE /api/platform/accounts/[id]/whatsapp.
 */
export async function DELETE() {
  try {
    const ctx = await requirePlatformOperator('billing')

    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const { error: deleteError } = await supabase
      .from('whatsapp_config')
      .delete()
      .eq('account_id', accountId)

    if (deleteError) {
      console.error('Error deleting whatsapp_config:', deleteError)
      return NextResponse.json(
        { error: 'Failed to delete configuration' },
        { status: 500 }
      )
    }

    await logPlatformAction(ctx, {
      accountId,
      action: 'WHATSAPP_DISCONNECTED',
      detail: { via: 'tenant_config_route' },
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    return toPlatformErrorResponse(error)
  }
}
