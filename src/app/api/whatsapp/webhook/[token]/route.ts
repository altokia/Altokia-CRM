// ============================================================
// /api/whatsapp/webhook/[token] — the PER-TENANT webhook address.
//
// ─── Why two webhook routes exist ─────────────────────────────────
// Meta signs every delivery with the App Secret of the app that sends
// it. Altokia connects each client's OWN Meta app, so there are N app
// secrets, and the deployment-wide META_APP_SECRET can validate exactly
// one of them — every other client would get 401 on every inbound
// message.
//
// The secret cannot be chosen from the payload: the payload is exactly
// what the signature exists to authenticate, so reading
// `metadata.phone_number_id` out of an unverified body to pick a secret
// would be trusting the attacker's own input. The tenant therefore has
// to be named by something OUTSIDE the signed bytes — the address
// itself. `<token>` is `whatsapp_config.webhook_token` (migration 045):
// 32 opaque hex chars, unique-indexed, one per account.
//
// ─── Which client uses which ──────────────────────────────────────
//   /api/whatsapp/webhook          → the original single-tenant install
//                                    and any client running on Altokia's
//                                    own Meta app. Verifies with
//                                    META_APP_SECRET.
//   /api/whatsapp/webhook/<token>  → every client with its own Meta app.
//                                    Verifies with that row's decrypted
//                                    `app_secret`, falling back to
//                                    META_APP_SECRET when the column is
//                                    NULL (so this address is also safe
//                                    to hand to a client still sharing
//                                    Altokia's app).
//
// Both addresses feed the SAME pipeline: `processWebhook` is imported
// from the shared route, never copied. The only thing this file owns is
// tenant resolution + signature verification.
// ============================================================

import { NextResponse, after } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import {
  processWebhook,
  type WhatsAppWebhookEntry,
} from '../route'

// Same reasoning as the shared route: the `after()` callback runs
// within this route's max duration, and inbound processing fans out to
// per-media Meta calls.
export const maxDuration = 60

// Lazy-initialized to avoid a build-time crash when env vars are
// missing. The webhook is public — there is no session to build an
// RLS-scoped client from — so tenant resolution runs as service role.
let _adminClient: SupabaseClient | null = null
function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}

interface TenantConfigRow {
  id: string
  account_id: string
  phone_number_id: string | null
  app_secret: string | null
  verify_token: string | null
}

/**
 * Cheap shape check before we touch the database. The column's default
 * is 32 lowercase hex chars; the range here is deliberately a little
 * wider so an operator can rotate a row to a custom token without a
 * code change, while still turning obvious junk (`favicon.ico`, path
 * probes) into a 404 for free.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/

/**
 * 404 for every "this token means nothing to us" case. Deliberately
 * identical for a malformed token, an unknown token, and a token whose
 * row was deleted — a caller probing the address space learns only that
 * it guessed wrong, never how close it got.
 */
function notFound() {
  return NextResponse.json({ error: 'Not found' }, { status: 404 })
}

/**
 * Resolve the tenant from the URL segment. Returns null when the token
 * doesn't name a row (caller answers 404) and throws only on an actual
 * infrastructure failure (caller answers 500, so Meta retries rather
 * than treating the endpoint as permanently gone).
 */
async function findConfigByToken(
  token: string,
): Promise<TenantConfigRow | null> {
  // `.maybeSingle()` is safe here: idx_whatsapp_config_webhook_token is
  // UNIQUE, so this is 0 or 1 rows by construction.
  const { data, error } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('id, account_id, phone_number_id, app_secret, verify_token')
    .eq('webhook_token', token)
    .maybeSingle()

  if (error) {
    throw new Error(`whatsapp_config lookup failed: ${error.message}`)
  }
  return (data as TenantConfigRow | null) ?? null
}

// GET — Meta's subscription handshake.
//
// Unlike the shared route (which decrypts every row's verify_token on
// each verification because it has no way to know which tenant is
// calling), the token already names the row: one indexed read, one
// decrypt.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await params
    if (!token || !TOKEN_PATTERN.test(token)) return notFound()

    const { searchParams } = new URL(request.url)
    const mode = searchParams.get('hub.mode')
    const challenge = searchParams.get('hub.challenge')
    const verifyToken = searchParams.get('hub.verify_token')

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json(
        { error: 'Missing verification parameters' },
        { status: 400 },
      )
    }

    const config = await findConfigByToken(token)
    if (!config) return notFound()

    if (!config.verify_token) {
      console.error(
        '[webhook:tenant] no verify_token stored for account',
        config.account_id,
      )
      return NextResponse.json(
        { error: 'Verification token mismatch' },
        { status: 403 },
      )
    }

    let storedVerifyToken: string
    try {
      storedVerifyToken = decrypt(config.verify_token)
    } catch (error) {
      // Wrong ENCRYPTION_KEY or a corrupted row. Same 403 as a mismatch
      // — the caller learns nothing either way — but log loudly, because
      // this one is our bug, not theirs.
      console.error(
        '[webhook:tenant] verify_token decrypt failed for account',
        config.account_id,
        error instanceof Error ? error.message : error,
      )
      return NextResponse.json(
        { error: 'Verification token mismatch' },
        { status: 403 },
      )
    }

    if (storedVerifyToken !== verifyToken) {
      return NextResponse.json(
        { error: 'Verification token mismatch' },
        { status: 403 },
      )
    }

    // Same opportunistic GCM upgrade the shared route does: a no-op once
    // the column is already GCM, and fire-and-forget so a failed write
    // can't stall Meta's handshake.
    if (isLegacyFormat(config.verify_token)) {
      void supabaseAdmin()
        .from('whatsapp_config')
        .update({ verify_token: encrypt(verifyToken) })
        .eq('id', config.id)
        .then((res) => {
          if (res.error) {
            console.warn(
              '[webhook:tenant] verify_token GCM upgrade failed:',
              res.error.message ?? res.error,
            )
          }
        })
    }

    // Meta expects the challenge echoed back as plain text.
    return new Response(challenge, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    })
  } catch (error) {
    console.error('[webhook:tenant] GET verification failed:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}

// POST — inbound messages and status updates for one tenant.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params
  if (!token || !TOKEN_PATTERN.test(token)) return notFound()

  // Read the raw body first so we HMAC exactly the bytes Meta signed.
  // request.json() would re-encode and break the signature.
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')

  let config: TenantConfigRow | null
  try {
    config = await findConfigByToken(token)
  } catch (error) {
    // Infrastructure failure, not a bad token: 500 so Meta retries the
    // delivery instead of recording a permanent failure.
    console.error('[webhook:tenant] config lookup failed:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
  if (!config) return notFound()

  // Resolve THIS tenant's app secret. A NULL column means the account
  // runs on Altokia's shared Meta app, so we pass `undefined` and the
  // verifier falls back to META_APP_SECRET.
  let appSecret: string | undefined
  if (config.app_secret) {
    try {
      appSecret = decrypt(config.app_secret)
    } catch (error) {
      // Never fall back to the global secret here: the row explicitly
      // declares its own app, so a decrypt failure is a configuration
      // fault to fix, not a reason to accept the request under another
      // app's identity.
      console.error(
        '[webhook:tenant] app_secret decrypt failed for account',
        config.account_id,
        error instanceof Error ? error.message : error,
      )
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    }
  }

  if (!verifyMetaWebhookSignature(rawBody, signature, appSecret)) {
    // 401 (not 200) — we want Meta's delivery dashboard to show failures
    // loudly if a misconfiguration causes signatures to stop matching,
    // rather than silently eating events.
    console.warn(
      '[webhook:tenant] rejected request with invalid signature for account',
      config.account_id,
    )
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: { entry?: WhatsAppWebhookEntry[] }
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Process AFTER the response so we ack Meta within their ~20s timeout,
  // while still guaranteeing the work runs to completion. This MUST use
  // `after()` rather than a detached promise — on serverless the
  // function can be frozen the moment the response is sent, silently
  // dropping DB writes (issue #301). See the shared route for the full
  // account.
  // Without a number on the row there is nothing to pin the payload to,
  // and processing it would mean trusting whatever number the (tenant-
  // signed) body names. 503 so Meta retries once the client's number is
  // actually connected, instead of the event being silently dropped.
  const expectedPhoneNumberId = config.phone_number_id?.trim()
  if (!expectedPhoneNumberId) {
    console.error(
      '[webhook/token] delivery for a config with no phone_number_id — refusing to process unanchored.',
      'account:',
      config.account_id,
    )
    return NextResponse.json({ error: 'Number not connected yet' }, { status: 503 })
  }
  after(async () => {
    try {
      // Same pipeline as the shared route — imported, never forked.
      // `expectedPhoneNumberId` pins the payload to the tenant whose
      // token was in the URL, so a client that knows its own App Secret
      // can't sign a payload naming someone else's phone_number_id.
      await processWebhook(body, {
        expectedPhoneNumberId,
        // Template and status events carry no phone number, so the pin
        // above cannot see them; the account id scopes those two writes.
        expectedAccountId: config.account_id,
      })
    } catch (error) {
      console.error('[webhook:tenant] error processing webhook:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}
