-- ============================================================
-- 047 — Close the media buckets
-- ============================================================
-- `chat-media` and `flow-media` were created public (023, 016) and since
-- 039 every inbound attachment a customer sends over WhatsApp — photos,
-- voice notes, receipts, identity documents — is mirrored into
-- `chat-media` by default. Public in Supabase means two things, and the
-- second is the dangerous one:
--
--   * anyone holding a URL can read the object, and
--   * anyone at all can LIST the bucket.
--
-- So the exposure was never bounded by whether a link leaked. The folder
-- convention is `account-<uuid>/…`, which means an anonymous caller
-- could enumerate every tenant and download the lot. With one customer
-- that was a latent bug; as a SaaS it is every client's data at once.
--
-- Closing it takes more than flipping the flag, because two readers
-- legitimately live outside a session:
--
--   * The BROWSER, which renders `messages.media_url` straight into
--     <img>/<audio>. It now reads through /api/media/<bucket>/<path>,
--     which checks the caller's account owns the folder and redirects to
--     a five-minute signed URL.
--   * META, which fetches outbound media itself — WhatsApp sends carry
--     `{ link }`, not bytes. The senders now mint a one-hour signed URL
--     at send time (lib/storage/outbound-link.ts).
--
-- `avatars` (008) stays public on purpose: they are team profile
-- pictures, deliberately displayed across the app, and proxying every
-- one of them would buy far less than it costs. It is on the list, not
-- forgotten.
--
-- Idempotent: safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- 1. The buckets stop being public
-- ------------------------------------------------------------
UPDATE storage.buckets
   SET public = FALSE
 WHERE id IN ('chat-media', 'flow-media');

-- ------------------------------------------------------------
-- 2. Reads become account-scoped, matching the write policies
-- ------------------------------------------------------------
-- The write policies these buckets have carried since 020/023 already
-- match on the first path segment. Read now agrees with write, so
-- "yours" means one thing in both directions.
DROP POLICY IF EXISTS "Chat media is publicly readable" ON storage.objects;
DROP POLICY IF EXISTS "Flow media is publicly readable" ON storage.objects;

DROP POLICY IF EXISTS "Members read own account chat media" ON storage.objects;
CREATE POLICY "Members read own account chat media"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'chat-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
       WHERE p.user_id = auth.uid()
         AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members read own account flow media" ON storage.objects;
CREATE POLICY "Members read own account flow media"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'flow-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
       WHERE p.user_id = auth.uid()
         AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

-- ------------------------------------------------------------
-- 3. Rewrite the URLs already stored on messages
-- ------------------------------------------------------------
-- Rows written before this migration carry a public object URL that will
-- now 404. Rewriting them to the proxy form keeps every historical
-- attachment viewable instead of leaving a thread full of broken images.
-- The read path also parses the legacy shape, so this is belt and
-- braces rather than the only thing standing between the user and a
-- blank bubble.
UPDATE messages
   SET media_url = '/api/media/chat-media/' ||
                   split_part(media_url, '/storage/v1/object/public/chat-media/', 2)
 WHERE media_url LIKE '%/storage/v1/object/public/chat-media/%';

UPDATE messages
   SET media_url = '/api/media/flow-media/' ||
                   split_part(media_url, '/storage/v1/object/public/flow-media/', 2)
 WHERE media_url LIKE '%/storage/v1/object/public/flow-media/%';
