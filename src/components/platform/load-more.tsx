'use client';

// ============================================================
// Cursor pagination without a "load more" button.
//
// A sentinel at the end of a list asks for the next page when it
// scrolls into view. The observer is rebuilt whenever `token` changes
// (the caller passes the current row count): after a page lands, a
// fresh observer re-fires immediately if the sentinel is *still* on
// screen, which is what keeps a short first page from stranding the
// rest behind a scroll that never happens.
// ============================================================

import { useEffect, useRef } from 'react';
import { Loader2 } from 'lucide-react';

export function LoadMore({
  token,
  busy,
  onReach,
}: {
  /** Changes whenever the list grows; re-arms the observer. */
  token: number;
  busy: boolean;
  /** Must be a no-op while a page is already in flight. */
  onReach: () => void;
}) {
  const sentinel = useRef<HTMLDivElement | null>(null);
  const handler = useRef(onReach);

  // Refs are never written during render — the compiler lint forbids
  // it, and an effect is soon enough for an observer callback.
  useEffect(() => {
    handler.current = onReach;
  }, [onReach]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) handler.current();
      },
      { rootMargin: '200px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [token]);

  return (
    <div ref={sentinel} className="flex h-10 items-center justify-center">
      {busy ? (
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      ) : null}
    </div>
  );
}
