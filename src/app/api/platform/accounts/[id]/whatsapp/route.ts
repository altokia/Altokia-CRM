// ============================================================
// /api/platform/accounts/[id]/whatsapp — connect a client's number
// on their behalf.
//
// This is the one screen Altokia runs FOR the customer: the customer
// owns the Meta app, the WABA and the number, and hands over the
// credentials; the operator pastes them here so the customer never has
// to meet the Cloud API console.
//
// Configuration, not content — no consent needed. What IS needed is
// care with secrets: the access token and the app secret are encrypted
// before they touch the database and never appear in the response or
// in the audit detail, which the client can read.
// ============================================================

import { NextResponse } from 'next/server'

import {
  logPlatformAction,
  requirePlatformOperator,
  toPlatformErrorResponse,
} from '@/lib/platform'
import { encrypt } from '@/lib/whatsapp/encryption'
import { subscribeWabaToApp, verifyPhoneNumber } from '@/lib/whatsapp/meta-api'

/** Mirrors the roster route; see the comment there. */
function resolveBaseUrl(request: Request): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (explicit) return explicit.replace(/\/+$/, '')

  const forwardedHost = request.headers
    .get('x-forwarded-host')
    ?.split(',')[0]
    ?.trim()
  if (forwardedHost) {
    const proto =
      request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || 'https'
    return `${proto}://${forwardedHost}`
  }

  const host = request.headers.get('host')?.trim()
  if (host) {
    const proto = new URL(request.url).protocol.replace(':', '')
    return `${proto}://${host}`
  }

  console.warn('[platform/whatsapp] could not derive a base URL from request')
  return ''
}

function requiredString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * PUT /api/platform/accounts/[id]/whatsapp
 *
 * Body: { phone_number_id, waba_id, access_token,
 *         app_id?, app_secret?, verify_token? }
 *
 * ─── webhook_token is written once, never rotated ─────────────────
 * The token is the last segment of this client's webhook address, and
 * that address is typed into Meta's app configuration by hand. Minting
 * a fresh one on every save would silently point Meta at a URL that no
 * longer resolves, and inbound messages would stop with no error
 * anywhere. So: a new row lets the column's DEFAULT (045) fill it, and
 * an existing row keeps whatever it already has.
 *
 * ─── app_secret ───────────────────────────────────────────────────
 * NULL means "this client rides Altokia's own Meta app", and the
 * per-tenant webhook falls back to META_APP_SECRET. Supplying one
 * switches that client onto its own app's signature — which is the
 * whole reason the column exists, since one global secret can only
 * ever validate one Meta app.
 */
export async function PUT(
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

    const phoneNumberId = requiredString(body.phone_number_id)
    const wabaId = requiredString(body.waba_id)
    const accessToken = requiredString(body.access_token)
    if (!phoneNumberId || !wabaId || !accessToken) {
      return NextResponse.json(
        { error: 'phone_number_id, waba_id and access_token are required' },
        { status: 400 }
      )
    }

    const appId = requiredString(body.app_id)
    const appSecret = requiredString(body.app_secret)
    const verifyToken = requiredString(body.verify_token)

    for (const [field, value] of [
      ['app_id', body.app_id],
      ['app_secret', body.app_secret],
      ['verify_token', body.verify_token],
    ] as const) {
      if (value !== undefined && value !== null && typeof value !== 'string') {
        return NextResponse.json(
          { error: `${field} must be a string` },
          { status: 400 }
        )
      }
    }

    // The account has to exist before we start calling Meta on its
    // behalf — a typo'd id should cost nothing.
    const { data: account, error: accountError } = await ctx.db
      .from('accounts')
      .select('id, name, status, owner_user_id')
      .eq('id', id)
      .maybeSingle()

    if (accountError) {
      console.error('[PUT /api/platform/.../whatsapp] account error:', accountError)
      return NextResponse.json(
        { error: 'Failed to load the account' },
        { status: 500 }
      )
    }
    if (!account) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    // whatsapp_config.phone_number_id is UNIQUE (013): a number already
    // bound to a different client would fail the constraint as a 500,
    // and worse, the webhook resolves the account BY this column — two
    // rows would send one client's messages into another's inbox.
    const { data: claimed, error: claimedError } = await ctx.db
      .from('whatsapp_config')
      .select('account_id')
      .eq('phone_number_id', phoneNumberId)
      .neq('account_id', id)
      .maybeSingle()

    if (claimedError) {
      console.error('[PUT /api/platform/.../whatsapp] claim check error:', claimedError)
      return NextResponse.json(
        { error: 'Failed to validate the phone number' },
        { status: 500 }
      )
    }
    if (claimed) {
      return NextResponse.json(
        {
          error:
            'That phone_number_id is already connected to another client on this deployment. Disconnect it there first.',
          claimed_by_account_id: claimed.account_id,
        },
        { status: 409 }
      )
    }

    // Ask Meta before writing anything. A credential that Meta rejects
    // is a 400 with Meta's own words — the operator is usually looking
    // at the same console and can act on them directly.
    let phoneInfo
    try {
      phoneInfo = await verifyPhoneNumber({
        phoneNumberId,
        accessToken,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error'
      console.error('[PUT /api/platform/.../whatsapp] Meta rejected credentials:', message)
      return NextResponse.json(
        { error: `Meta rejected these credentials: ${message}` },
        { status: 400 }
      )
    }

    let encryptedAccessToken: string
    let encryptedAppSecret: string | null = null
    let encryptedVerifyToken: string | null = null
    try {
      encryptedAccessToken = encrypt(accessToken)
      if (appSecret) encryptedAppSecret = encrypt(appSecret)
      if (verifyToken) encryptedVerifyToken = encrypt(verifyToken)
    } catch (err) {
      console.error('[PUT /api/platform/.../whatsapp] encryption failed:', err)
      return NextResponse.json(
        {
          error:
            'Failed to encrypt the credentials. Check that ENCRYPTION_KEY is a 64-character hex string in this environment.',
        },
        { status: 500 }
      )
    }

    // Subscribing the WABA to the app is idempotent on Meta's side and
    // is what actually makes inbound events flow; the existing tenant
    // route does it on every save for the same reason. Non-fatal:
    // credentials that verify are worth storing even if this call is
    // refused, and `subscribed_apps_at` records whether it landed.
    let subscribedAppsAt: string | null = null
    try {
      await subscribeWabaToApp({ wabaId, accessToken })
      subscribedAppsAt = new Date().toISOString()
    } catch (err) {
      console.warn(
        '[PUT /api/platform/.../whatsapp] subscribed_apps failed (non-fatal):',
        err instanceof Error ? err.message : err
      )
    }

    const { data: existing, error: existingError } = await ctx.db
      .from('whatsapp_config')
      .select('id, webhook_token, verify_token')
      .eq('account_id', id)
      .maybeSingle()

    if (existingError) {
      console.error('[PUT /api/platform/.../whatsapp] existing lookup error:', existingError)
      return NextResponse.json(
        { error: 'Failed to load the current configuration' },
        { status: 500 }
      )
    }

    const nowIso = new Date().toISOString()
    const row: Record<string, unknown> = {
      phone_number_id: phoneNumberId,
      waba_id: wabaId,
      access_token: encryptedAccessToken,
      app_id: appId,
      status: 'connected',
      connected_at: nowIso,
      last_registration_error: null,
      updated_at: nowIso,
    }
    // Only overwrite the optional secrets when this call supplies them:
    // a save that omits `app_secret` must not silently move a client
    // off its own Meta app and back onto the shared one.
    if (encryptedAppSecret) row.app_secret = encryptedAppSecret
    if (encryptedVerifyToken) row.verify_token = encryptedVerifyToken
    if (subscribedAppsAt) row.subscribed_apps_at = subscribedAppsAt

    const SELECT_BACK =
      'id, account_id, phone_number_id, waba_id, app_id, status, connected_at, registered_at, subscribed_apps_at, webhook_token, updated_at'

    let saved: {
      id: string
      account_id: string
      phone_number_id: string
      waba_id: string | null
      app_id: string | null
      status: string
      connected_at: string | null
      registered_at: string | null
      subscribed_apps_at: string | null
      webhook_token: string | null
      updated_at: string | null
    } | null = null

    if (existing) {
      // webhook_token deliberately absent from `row` — see the doc block.
      const { data, error } = await ctx.db
        .from('whatsapp_config')
        .update(row)
        .eq('account_id', id)
        .select(SELECT_BACK)
        .maybeSingle()
      if (error) {
        console.error('[PUT /api/platform/.../whatsapp] update error:', error)
        return NextResponse.json(
          { error: 'Failed to save the configuration' },
          { status: 500 }
        )
      }
      saved = data
    } else {
      const { data, error } = await ctx.db
        .from('whatsapp_config')
        .insert({
          account_id: id,
          // Anchor the row to the CLIENT's owner, never to the operator
          // who saved it. whatsapp_config.user_id cascades from
          // auth.users (001) and is the audit identity the webhook
          // stamps on every contact and conversation it creates, plus
          // the one resolveAuditUserId hands the public API. With an
          // operator there, offboarding that operator — which the
          // console has a button for — would delete the customer's
          // WhatsApp connection and orphan their inbound writes.
          // Who actually saved it is in the audit log.
          user_id: account.owner_user_id,
          ...row,
        })
        .select(SELECT_BACK)
        .maybeSingle()
      if (error) {
        console.error('[PUT /api/platform/.../whatsapp] insert error:', error)
        return NextResponse.json(
          { error: 'Failed to save the configuration' },
          { status: 500 }
        )
      }
      saved = data
    }

    if (!saved) {
      return NextResponse.json(
        { error: 'The configuration was not saved' },
        { status: 500 }
      )
    }

    const baseUrl = resolveBaseUrl(request)
    const webhookUrl = saved.webhook_token
      ? `${baseUrl}/api/whatsapp/webhook/${saved.webhook_token}`
      : null

    await logPlatformAction(ctx, {
      accountId: id,
      action: 'WHATSAPP_CONNECTED',
      detail: {
        phone_number_id: phoneNumberId,
        waba_id: wabaId,
        app_id: appId,
        // Recorded because Meta only reveals the human-readable number
        // at verify time and no column holds it; the console reads it
        // back from here.
        display_phone_number: phoneInfo.display_phone_number ?? null,
        verified_name: phoneInfo.verified_name ?? null,
        quality_rating: phoneInfo.quality_rating ?? null,
        // Flags, never values. The access token, the app secret and the
        // verify token stay out of a log the client can read.
        own_app_secret: encryptedAppSecret !== null,
        verify_token_updated: encryptedVerifyToken !== null,
        waba_subscribed: subscribedAppsAt !== null,
        created: !existing,
      },
    })

    return NextResponse.json({
      config: saved,
      phone_info: phoneInfo,
      // The address to paste into Meta → WhatsApp → Configuration.
      webhook_url: webhookUrl,
      // The GET handshake on that address compares Meta's
      // hub.verify_token against the stored one, so without it Meta's
      // subscription can never be verified. Surfaced as a flag so the
      // console can say so instead of the operator finding out from
      // Meta's error.
      verify_token_set: Boolean(encryptedVerifyToken || existing?.verify_token),
      waba_subscribed: subscribedAppsAt !== null,
    })
  } catch (err) {
    return toPlatformErrorResponse(err)
  }
}
