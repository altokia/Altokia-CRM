/**
 * Where a stored media URL points, and how to turn it into something the
 * browser or Meta can actually fetch.
 *
 * Until migration 047 the `chat-media` and `flow-media` buckets were
 * public, so a stored `messages.media_url` was a plain https URL anyone
 * could open — and, because a public bucket is also listable, anyone
 * could enumerate every account's folder and pull down every customer's
 * photos, voice notes and documents. That is now closed: the buckets are
 * private and the two readers that legitimately need the bytes get them
 * a different way.
 *
 *   * The BROWSER reads through `/api/media/<bucket>/<path>`, which
 *     checks the caller's session and that the path belongs to their
 *     account before handing back a short-lived signed URL.
 *   * META reads through a signed URL minted at send time. Outbound
 *     media is delivered to WhatsApp as `{ link }` (see
 *     `sendMediaMessage`), i.e. Meta's servers fetch the file
 *     themselves, so the link has to be reachable without a session —
 *     but only for as long as that fetch takes.
 *
 * Everything here is pure string work so it can run on either side.
 */

/** Buckets whose objects are private and account-scoped. */
export const PRIVATE_MEDIA_BUCKETS = ['chat-media', 'flow-media'] as const;
export type PrivateMediaBucket = (typeof PRIVATE_MEDIA_BUCKETS)[number];

/** Prefix of the account-scoped media proxy. */
export const MEDIA_PROXY_PREFIX = '/api/media/';

/**
 * How long a signed URL handed to Meta stays valid.
 *
 * Meta fetches the link while the send request is still in flight, so
 * minutes would do; an hour absorbs a retry or a slow queue without
 * leaving a URL that is useful to anyone who finds it later.
 */
export const OUTBOUND_SIGN_TTL_SECONDS = 60 * 60;

/** How long the browser's redirect target stays valid. */
export const BROWSER_SIGN_TTL_SECONDS = 60 * 5;

export interface StorageRef {
  bucket: string;
  path: string;
}

export function isPrivateMediaBucket(value: string): value is PrivateMediaBucket {
  return (PRIVATE_MEDIA_BUCKETS as readonly string[]).includes(value);
}

/**
 * Resolve any of the three shapes a stored media URL can have into the
 * bucket and object path behind it, or null when it points somewhere
 * else entirely (the inbound Meta proxy, or an external link).
 *
 * Handles the legacy public form because rows written before 047 still
 * carry it, and rewriting every historical row is not something a read
 * path should depend on.
 */
export function parseStorageUrl(url: string | null | undefined): StorageRef | null {
  if (!url) return null;

  // Our own proxy: /api/media/<bucket>/<path...>
  if (url.startsWith(MEDIA_PROXY_PREFIX)) {
    const rest = url.slice(MEDIA_PROXY_PREFIX.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) return null;
    const bucket = rest.slice(0, slash);
    const path = safeDecode(rest.slice(slash + 1).split('?')[0]);
    return path ? { bucket, path } : null;
  }

  // Supabase public or signed object URL.
  const marker = '/storage/v1/object/';
  const at = url.indexOf(marker);
  if (at === -1) return null;
  let rest = url.slice(at + marker.length);
  for (const kind of ['public/', 'sign/', 'authenticated/']) {
    if (rest.startsWith(kind)) {
      rest = rest.slice(kind.length);
      break;
    }
  }
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const bucket = rest.slice(0, slash);
  const path = safeDecode(rest.slice(slash + 1).split('?')[0]);
  return path ? { bucket, path } : null;
}

/** The URL the browser should use for an object in a private bucket. */
export function toMediaProxyUrl(bucket: string, path: string): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `${MEDIA_PROXY_PREFIX}${bucket}/${encoded}`;
}

/**
 * The account folder an object sits in, e.g. `account-<uuid>/photo.jpg`
 * yields the uuid. Null when the path does not follow the convention —
 * which is itself a reason to refuse the read.
 */
export function accountIdFromPath(path: string): string | null {
  const first = path.split('/')[0] ?? '';
  return first.startsWith('account-') ? first.slice('account-'.length) : null;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
