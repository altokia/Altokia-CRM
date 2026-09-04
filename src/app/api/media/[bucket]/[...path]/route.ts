import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import {
  BROWSER_SIGN_TTL_SECONDS,
  accountIdFromPath,
  isPrivateMediaBucket,
} from '@/lib/storage/media-url'

/**
 * GET /api/media/<bucket>/<path...> — the only way a browser reads a
 * private media object.
 *
 * Migration 047 made `chat-media` and `flow-media` private. They hold
 * what customers send over WhatsApp: photos, voice notes, receipts,
 * identity documents. While the buckets were public those objects were
 * not merely guessable, they were *listable*, so one URL was never the
 * limit of an exposure — the whole folder of every account was.
 *
 * The check here is deliberately narrow: the caller must have a session,
 * and the object's first path segment must name their own account. That
 * mirrors the write policies the buckets have carried since 020/023, so
 * read and write agree on what "yours" means.
 *
 * It answers with a redirect to a short-lived signed URL rather than
 * streaming the bytes. Two reasons: the file is served by Supabase's CDN
 * instead of a Node function that would hold the whole object in memory,
 * and `<img>`, `<audio>` and a download link all follow a redirect
 * natively, so nothing on the page had to change shape.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ bucket: string; path: string[] }> },
) {
  try {
    const { bucket, path: segments } = await params
    if (!isPrivateMediaBucket(bucket)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const path = segments.map((s) => decodeURIComponent(s)).join('/')
    // `..` would let a crafted path climb out of the account folder
    // before the prefix check below ever ran.
    if (!path || path.includes('..')) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const ctx = await getCurrentAccount()

    const owner = accountIdFromPath(path)
    if (!owner || owner !== ctx.accountId) {
      // 404, not 403: whether another account holds a file at this path
      // is not something to confirm.
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const { data, error } = await supabaseAdmin()
      .storage.from(bucket)
      .createSignedUrl(path, BROWSER_SIGN_TTL_SECONDS)

    if (error || !data?.signedUrl) {
      console.error('[media] sign failed for', bucket, path, error?.message)
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    return NextResponse.redirect(data.signedUrl, {
      status: 302,
      headers: {
        // The signed URL outlives a single response but not by much;
        // letting a shared cache keep the redirect would hand it to the
        // next viewer, who may be in another account.
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
