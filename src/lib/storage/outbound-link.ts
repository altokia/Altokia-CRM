import type { SupabaseClient } from '@supabase/supabase-js'

import {
  OUTBOUND_SIGN_TTL_SECONDS,
  isPrivateMediaBucket,
  parseStorageUrl,
} from './media-url'

/**
 * Turn whatever we stored on a message into a link Meta can fetch.
 *
 * Outbound media is delivered to WhatsApp as `{ link }` — Meta's servers
 * download the file themselves, with no session and no header we
 * control. That is why the buckets could not simply be closed when 047
 * made them private: the fix has to keep exactly one reader outside the
 * app, for exactly as long as the fetch takes.
 *
 * So an object in a private bucket is signed here, minutes before the
 * send, and the URL dies an hour later. Anything else — an already
 * signed URL, or a link to somewhere that is not our storage — is
 * returned untouched.
 *
 * Throws rather than falling back to the unsigned path: a media send
 * that silently goes out with a URL Meta cannot read looks to the
 * operator like Meta rejecting the file, and costs an afternoon.
 */
export async function resolveOutboundMediaLink(
  admin: SupabaseClient,
  link: string,
): Promise<string> {
  const ref = parseStorageUrl(link)
  if (!ref || !isPrivateMediaBucket(ref.bucket)) return link

  const { data, error } = await admin.storage
    .from(ref.bucket)
    .createSignedUrl(ref.path, OUTBOUND_SIGN_TTL_SECONDS)

  if (error || !data?.signedUrl) {
    throw new Error(
      `could not sign media for delivery (${ref.bucket}/${ref.path}): ${error?.message ?? 'no url returned'}`,
    )
  }
  return data.signedUrl
}
