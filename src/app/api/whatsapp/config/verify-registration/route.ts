import { NextResponse } from 'next/server'
import {
  logPlatformAction,
  requirePlatformOperator,
  toPlatformErrorResponse,
} from '@/lib/platform'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  getSubscribedApps,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api'

/**
 * GET /api/whatsapp/config/verify-registration?account_id=… — STAFF ONLY.
 *
 * Confirms that a number Altokia connected is actually reachable on
 * Meta's side. Solves the failure mode that surfaced the multi-number
 * bug originally: "the CRM says Connected but Meta isn't delivering
 * events."
 *
 * It moved to the platform plane along with the connection itself. Two
 * reasons it had to: it answers with Meta's own error strings and with
 * remediation steps ("re-enter the token", "re-save to subscribe")
 * that only an operator can carry out, and it spends the client's
 * stored access token against Meta, which is not a call a customer's
 * settings page should be able to trigger. The console's WhatsApp card
 * is the caller.
 *
 * `account_id` names the client to probe. Omitted, it falls back to the
 * caller's own account — operators are members of no customer account
 * (045), so that only resolves on a dev deployment where they are.
 *
 * Three checks run independently so the console can show which step
 * passes and which fails:
 *
 *   1. phone_info  — GET /{phone_number_id} succeeds
 *   2. waba_subscription — our app appears in
 *                    GET /{waba_id}/subscribed_apps
 *   3. registered_at — timestamp set when /register last succeeded;
 *                    NULL means the number was saved but never
 *                    actually subscribed
 *
 * Returns 200 in every case once the caller is staff, so the console
 * renders diagnostic detail rather than a generic error toast. The
 * combined `live` flag is what the UI badges on.
 */
export async function GET(request: Request) {
  try {
    const ctx = await requirePlatformOperator()

    const requested = new URL(request.url).searchParams.get('account_id')?.trim()
    let accountId = requested || null

    if (!accountId) {
      const { data: profile } = await ctx.db
        .from('profiles')
        .select('account_id')
        .eq('user_id', ctx.userId)
        .maybeSingle()
      accountId = (profile?.account_id as string | undefined) ?? null
    }

    if (!accountId) {
      return NextResponse.json({
        live: false,
        checks: { config_exists: false },
        message: 'No account to check — pass ?account_id=.',
      })
    }

    // Read with the service-role client: whatsapp_config is one row per
    // account under RLS the operator is outside of, so the operator's own
    // session would see nothing at all.
    const { data: config } = await ctx.db
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .maybeSingle()

    if (!config) {
      return NextResponse.json({
        live: false,
        checks: { config_exists: false },
        message: 'No WhatsApp configuration saved yet.',
      })
    }

    let accessToken: string
    try {
      accessToken = decrypt(config.access_token)
    } catch {
      return NextResponse.json({
        live: false,
        checks: {
          config_exists: true,
          token_decryptable: false,
        },
        message:
          'Stored access token can\'t be decrypted — likely ENCRYPTION_KEY changed. Re-enter the token to repair.',
      })
    }

    const checks: {
      config_exists: boolean
      token_decryptable: boolean
      phone_metadata_ok: boolean
      waba_subscribed_to_app: boolean | null
      locally_marked_registered: boolean
    } = {
      config_exists: true,
      token_decryptable: true,
      phone_metadata_ok: false,
      waba_subscribed_to_app: null,
      locally_marked_registered: config.registered_at != null,
    }
    const errors: string[] = []

    // 1. Phone metadata
    try {
      await verifyPhoneNumber({
        phoneNumberId: config.phone_number_id,
        accessToken,
      })
      checks.phone_metadata_ok = true
    } catch (err) {
      errors.push(
        `Phone metadata check failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    // 2. WABA subscription — only meaningful if we have a waba_id
    if (config.waba_id) {
      try {
        const subs = await getSubscribedApps({
          wabaId: config.waba_id,
          accessToken,
        })
        // Meta returns the apps subscribed to this WABA. If the list
        // is non-empty, OUR app is in there (the access_token we used
        // belongs to our app — Meta wouldn't return data for an app
        // the token can't see). Treat any entry as success.
        checks.waba_subscribed_to_app = subs.length > 0
        if (!checks.waba_subscribed_to_app) {
          errors.push(
            'WABA has no subscribed apps. Re-save the configuration to subscribe.',
          )
        }
      } catch (err) {
        errors.push(
          `WABA subscription check failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    } else {
      errors.push(
        'No WABA ID on file — webhooks can\'t be wired without it. Add it in the form and re-save.',
      )
    }

    const live =
      checks.phone_metadata_ok &&
      (checks.waba_subscribed_to_app ?? false) &&
      checks.locally_marked_registered

    // Logged because the probe spends the client's own access token
    // against Meta. Outcome only — no credential ever reaches the log.
    await logPlatformAction(ctx, {
      accountId,
      action: 'WHATSAPP_REGISTRATION_CHECKED',
      detail: { live, checks },
    })

    return NextResponse.json({
      live,
      checks,
      errors,
      last_registration_error: config.last_registration_error ?? null,
      registered_at: config.registered_at ?? null,
      subscribed_apps_at: config.subscribed_apps_at ?? null,
    })
  } catch (err) {
    return toPlatformErrorResponse(err)
  }
}
