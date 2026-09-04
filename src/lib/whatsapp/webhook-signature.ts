import crypto from 'node:crypto'

/**
 * Verify the HMAC-SHA256 signature Meta attaches to webhook POSTs.
 *
 * Meta signs the raw request body with your App Secret and sends the
 * result in the `x-hub-signature-256: sha256=<hex>` header. Without
 * verification, anyone who knows our webhook URL can POST fabricated
 * status updates and drift broadcast counts arbitrarily.
 *
 * Reference:
 *   https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verify-payloads
 *
 * Contract:
 *   A secret is **required**. If none resolves we fail closed — every
 *   request is rejected until the operator configures one. A previous
 *   version fell open with a warning log, which is unsafe for a public
 *   template: anyone who forgets the env var would be running a fully
 *   spoofable webhook.
 *
 * Where the secret comes from (multi-tenant):
 *   Each tenant connects its OWN Meta app, so there are N app secrets
 *   and a single env var can validate exactly one of them. Callers that
 *   already resolved the tenant — the per-tenant webhook address at
 *   `/api/whatsapp/webhook/[token]` — pass that tenant's secret in
 *   `appSecret`. Callers that haven't (the original shared route) omit
 *   it and get `META_APP_SECRET`, which is what the deployment's
 *   first/original tenant uses. Passing an empty string still fails
 *   closed: it means "the tenant was resolved and has no usable
 *   secret", never "fall back to the global one".
 */
export function verifyMetaWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret?: string | null,
): boolean {
  // `??` — not `||` — so only an absent secret falls back to the env
  // var. See the empty-string note above.
  const secret = appSecret ?? process.env.META_APP_SECRET
  if (!secret) {
    console.error(
      appSecret === undefined || appSecret === null
        ? '[webhook] META_APP_SECRET is not set — rejecting request. ' +
            'Configure the env var (Meta → App Settings → Basic → App Secret) ' +
            'to enable signature verification.'
        : '[webhook] empty per-tenant app secret — rejecting request. ' +
            'Store the tenant App Secret on whatsapp_config.app_secret, ' +
            'or leave it NULL to fall back to META_APP_SECRET.',
    )
    return false
  }

  if (!signatureHeader) return false
  if (!signatureHeader.startsWith('sha256=')) return false

  const expected =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(rawBody).digest('hex')

  const a = Buffer.from(signatureHeader)
  const b = Buffer.from(expected)
  // Bail if lengths differ — timingSafeEqual throws otherwise.
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}
