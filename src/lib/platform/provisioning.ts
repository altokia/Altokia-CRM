/**
 * Provisioning: Altokia creates the login, hands over the password, and
 * keeps the power to take it back.
 *
 * The console used to be able to do none of that. An account could only
 * be *claimed* after the customer had signed up on their own, because
 * `accounts.owner_user_id` is NOT NULL with a unique index (017, locked).
 * That constraint never actually required the customer to sign up — it
 * only required a row in `auth.users` to exist first, and the admin API
 * makes one on demand. Creating it fires the very same `handle_new_user`
 * trigger a self-signup fires (017), so the workspace and the owner
 * profile appear exactly as they always have. This module is the small
 * set of primitives that turns that into a sale: a password a human can
 * read down a phone line, the service-role auth client, and the switch
 * that locks a whole client out.
 *
 * Three rules hold in here:
 *
 *   1. A password exists in exactly two places: the response that
 *      returned it, and Supabase Auth. Never a table, never a log line,
 *      never an audit `detail` — the customer can read that table (045).
 *   2. Every write goes through the service role, and the caller is
 *      responsible for having proved the operator's role first. Nothing
 *      in here checks it, so nothing in here may be reached by a route
 *      that has not called `requirePlatformOperator('billing')`.
 *   3. Locking a client out has to put the people already inside out
 *      too. A block that only stops the next sign-in is a feature that
 *      starts working tomorrow morning.
 */

import { randomBytes } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import { PlatformAuthError } from '@/lib/platform'

// ------------------------------------------------------------
// Passwords
// ------------------------------------------------------------

/**
 * Unambiguous alphabet — 57 characters.
 *
 * These credentials get read out over the phone and typed by hand from
 * a WhatsApp message, so every character with a look-alike is gone: no
 * `0`/`O`, no `1`/`l`/`I`. Symbols are gone for the same reason ("guion
 * bajo, no, el de abajo" is a support call). It costs nothing: 57
 * characters carry ~5,83 bits each, so the 16-character default is ~93
 * bits of entropy — far past anything a brute force reaches.
 */
const PASSWORD_ALPHABET =
  'ABCDEFGHJKLMNPQRSTUVWXYZ' + 'abcdefghijkmnopqrstuvwxyz' + '23456789'

/** Largest multiple of the alphabet that fits in a byte — see below. */
const UNBIASED_CEILING = 256 - (256 % PASSWORD_ALPHABET.length) // 228 of 57

/** Floor for a password an operator types in themselves. */
export const MIN_PASSWORD_LENGTH = 10

/**
 * Ceiling, in bytes. GoTrue hashes with bcrypt, which ignores everything
 * past 72 bytes — accepting a longer one would silently mean something
 * different from what the operator typed.
 */
const MAX_PASSWORD_BYTES = 72

const MIN_GENERATED_LENGTH = MIN_PASSWORD_LENGTH
const MAX_GENERATED_LENGTH = 64

/**
 * A random password that survives being dictated.
 *
 * `randomBytes`, not `Math.random`: this is a credential, and the only
 * reason a CSPRNG ever gets skipped is not noticing it was one.
 *
 * Bytes at or above `UNBIASED_CEILING` are thrown away rather than
 * folded with `%`. Taking `byte % 57` across the whole 0–255 range would
 * make the first 28 letters of the alphabet ~25% likelier than the rest
 * — the classic modulo bias: small, real, and free to avoid.
 *
 * The result is re-rolled until it carries an upper, a lower and a
 * digit, so it satisfies any password policy this project may switch on
 * later, rather than discovering that at the worst possible moment.
 */
export function generatePassword(length = 16): string {
  const requested = Math.trunc(Number(length))
  const size = Number.isFinite(requested)
    ? Math.min(MAX_GENERATED_LENGTH, Math.max(MIN_GENERATED_LENGTH, requested))
    : MIN_GENERATED_LENGTH

  // Bounded: an attempt only fails when a character class is missing,
  // which at length >= 10 happens well under 1% of the time.
  for (let attempt = 0; attempt < 20; attempt++) {
    const out: string[] = []
    while (out.length < size) {
      // Ask for more bytes than needed so rejections rarely cost a
      // second syscall.
      const bytes = randomBytes(size * 2)
      for (const byte of bytes) {
        if (byte >= UNBIASED_CEILING) continue
        out.push(PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length])
        if (out.length === size) break
      }
    }
    const candidate = out.join('')
    if (/[A-Z]/.test(candidate) && /[a-z]/.test(candidate) && /[0-9]/.test(candidate)) {
      return candidate
    }
  }

  // Unreachable in practice. Throwing beats returning something weaker.
  throw new Error('Could not generate a password')
}

/**
 * Is this something we are willing to hand a customer as a password?
 *
 * Deliberately not a strength meter. It rejects the three things that
 * actually break: too short to be worth having, longer than bcrypt
 * reads, and edge whitespace or control characters — which survive a
 * copy-paste into the form, are invisible on screen, and come back as
 * "the password you gave me does not work".
 */
export function isAcceptablePassword(value: unknown): boolean {
  if (typeof value !== 'string') return false
  if (value.length < MIN_PASSWORD_LENGTH) return false
  if (Buffer.byteLength(value, 'utf8') > MAX_PASSWORD_BYTES) return false
  if (value !== value.trim()) return false
  // C0 controls and DEL. A tab or a newline in a dictated password is
  // always an accident.
  if (/[\u0000-\u001f\u007f]/.test(value)) return false
  return true
}

// ------------------------------------------------------------
// The service-role auth client
// ------------------------------------------------------------

let adminAuthClient: SupabaseClient | null = null

/**
 * Service-role Supabase client, ready for `.auth.admin.*`.
 *
 * Separate from the `supabaseAdmin()` instance that `ctx.db` already is,
 * on purpose: this one is built with `persistSession` and
 * `autoRefreshToken` off. An admin-API client that keeps a session is a
 * client that can, in the wrong circumstances, start signing requests
 * with something other than the service key. On a server there is no
 * session worth keeping, so saying so costs nothing.
 *
 * Throws instead of `!`-asserting the environment: a missing service key
 * would otherwise surface as an opaque auth failure halfway through
 * creating a customer's login, which is a terrible place to learn about
 * a deployment problem.
 */
export function adminAuth(): SupabaseClient {
  if (!adminAuthClient) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) {
      throw new PlatformAuthError(
        'Supabase admin credentials are not configured on this deployment',
        500,
      )
    }
    adminAuthClient = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  }
  return adminAuthClient
}

// ------------------------------------------------------------
// Links an operator copies into a WhatsApp message
// ------------------------------------------------------------

/**
 * The public base URL for links we hand an operator.
 *
 * `NEXT_PUBLIC_SITE_URL` wins when set (the deployment's own answer);
 * otherwise the proxy headers, which is what makes links work behind
 * Hostinger / Vercel / Cloudflare without an env var. Falls back to an
 * empty string so the caller still gets a usable relative path rather
 * than a link pointing at somebody else's domain.
 */
export function resolveBaseUrl(request: Request): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (explicit) return explicit.replace(/\/+$/, '')

  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
  if (forwardedHost) {
    const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || 'https'
    return `${proto}://${forwardedHost}`
  }

  const host = request.headers.get('host')?.trim()
  if (host) {
    const proto = new URL(request.url).protocol.replace(':', '')
    return `${proto}://${host}`
  }

  console.warn('[platform/provisioning] could not derive a base URL from request')
  return ''
}

/** Where the credentials we just issued are meant to be typed. */
export function loginUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/login`
}

// ------------------------------------------------------------
// Access: locking a whole client out, and letting them back in
// ------------------------------------------------------------

/**
 * A ban long enough to be permanent. GoTrue parses a Go duration string
 * and its largest unit is the hour ("ns", "us", "ms", "s", "m", "h"), so
 * a century is spelled in hours. `'none'` lifts it.
 */
const BAN_FOREVER = '876000h'

/** How many admin-API calls run at once. Polite to the auth server. */
const AUTH_BATCH = 5

export interface AccountAccessChange {
  accountId: string
  /** true = lock the client out, false = let them back in. */
  revoked: boolean
  /** The operator answering for it — stored in `access_revoked_by`. */
  operatorId: string
  /** Required by the caller when revoking; the customer is shown it. */
  reason?: string | null
}

/**
 * Apply or lift Altokia's block on an entire client. Returns how many
 * logins it touched.
 *
 * ─── Why a ban AND a new password ─────────────────────────────────
 * `ban_duration` is the admin API's own switch (present on
 * `AdminUserAttributes` in the installed @supabase/auth-js 2.108.2). It
 * stops the next sign-in and stops the refresh grant. It does not reach
 * the access token already sitting in a browser tab: PostgREST verifies
 * that token's signature locally and never asks GoTrue whether the user
 * has since been banned, so an open session keeps working until the
 * token expires on its own.
 *
 * The installed SDK exposes no admin call that ends a session, either.
 * `GoTrueAdminApi.signOut(jwt)` needs the *user's own* JWT, which an
 * operator by definition does not have, and there is no
 * `deleteSessions`-style method next to it. What GoTrue does do is drop
 * a user's refresh tokens when an admin changes their password. So
 * revoking also rotates every member's password to a fresh random string
 * that nobody — including us — has ever seen. That is what actually
 * pushes the people already inside back out.
 *
 * The consequence is deliberate, and the routes say it out loud:
 * REVOKING DESTROYS THE CLIENT'S PASSWORDS. Restoring lifts the ban but
 * cannot bring them back. The owner gets a new one from
 * `PUT /api/platform/accounts/[id]/credentials`; their staff can use the
 * ordinary forgotten-password flow.
 *
 * Idempotent, which matters because a partial revocation throws instead
 * of reporting success: running it again is always safe.
 */
export async function setAccountAccess(
  db: SupabaseClient,
  { accountId, revoked, operatorId, reason }: AccountAccessChange,
): Promise<number> {
  const { data: account, error: accountError } = await db
    .from('accounts')
    .select('id, owner_user_id')
    .eq('id', accountId)
    .maybeSingle()

  if (accountError) {
    console.error('[platform/provisioning] account lookup failed:', accountError)
    throw new PlatformAuthError('Could not load the account', 500)
  }
  if (!account) throw new PlatformAuthError('Not found', 404)

  const { data: members, error: membersError } = await db
    .from('profiles')
    .select('user_id')
    .eq('account_id', accountId)

  if (membersError) {
    console.error('[platform/provisioning] member lookup failed:', membersError)
    throw new PlatformAuthError('Could not list the people in this account', 500)
  }

  // The owner is unioned in rather than trusted to show up in the
  // member list: if their profile ever pointed elsewhere, a revocation
  // that skipped them would leave the one login that matters open.
  const userIds = Array.from(
    new Set(
      [
        account.owner_user_id as string | null,
        ...((members ?? []) as { user_id: string | null }[]).map((m) => m.user_id),
      ].filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  )

  const auth = adminAuth().auth.admin
  const failed: string[] = []

  for (let i = 0; i < userIds.length; i += AUTH_BATCH) {
    const slice = userIds.slice(i, i + AUTH_BATCH)
    const results = await Promise.all(
      slice.map((userId) =>
        auth.updateUserById(
          userId,
          revoked
            ? { ban_duration: BAN_FOREVER, password: generatePassword(24) }
            : { ban_duration: 'none' },
        ),
      ),
    )
    results.forEach((result, index) => {
      if (result.error) {
        // The user id is safe to log. The password never is.
        console.error(
          `[platform/provisioning] ${revoked ? 'revoke' : 'restore'} failed for user ${slice[index]}:`,
          result.error.message,
        )
        failed.push(slice[index])
      }
    })
  }

  if (failed.length > 0) {
    throw new PlatformAuthError(
      `Supabase Auth refused ${failed.length} of ${userIds.length} logins. The account was left unchanged on our side — run the same action again.`,
      502,
    )
  }

  // The column is written only once the enforcement actually holds, so
  // the console can never show "revoked" over people who can still sign
  // in. The other order would be a lie the customer cannot see.
  const trimmedReason = typeof reason === 'string' ? reason.trim() : ''
  const { error: stampError } = await db
    .from('accounts')
    .update({
      access_revoked_at: revoked ? new Date().toISOString() : null,
      access_revoked_by: revoked ? operatorId : null,
      access_revoked_reason: revoked ? trimmedReason || null : null,
    })
    .eq('id', accountId)

  if (stampError) {
    console.error('[platform/provisioning] access stamp failed:', stampError)
    throw new PlatformAuthError(
      revoked
        ? 'The logins were blocked but the account could not be marked as revoked. Run the action again.'
        : 'The logins were unblocked but the account still reads as revoked. Run the action again.',
      500,
    )
  }

  return userIds.length
}
