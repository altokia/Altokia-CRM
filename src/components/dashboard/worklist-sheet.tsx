"use client"

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { CheckCircle2, Loader2, TriangleAlert } from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  fetchWorklist,
  type WorklistItem,
  type WorklistKey,
} from '@/lib/dashboard/worklist'
import { Skeleton } from './skeleton'

/**
 * The list behind a counter.
 *
 * "Seguimientos vencidos: 7" is only useful if you can find out which
 * seven, and working that list is the most ordinary thing a person does
 * in a CRM. A side sheet — the same one contacts and deals already open
 * in — keeps the panel on screen behind it, so closing the list puts
 * the operator back where they were instead of on a different page.
 *
 * Every row is a link out to where the work actually happens (the
 * thread, the board, the queue); nothing is edited in here.
 */

/**
 * What the panel asks for. `nonce` changes on every open so re-opening
 * the same list remounts the body and re-reads it — a queue that is
 * three minutes stale is worse than no queue.
 */
export interface WorklistRequest {
  key: WorklistKey
  /** The counter's own label, so the sheet is titled what was clicked. */
  title: string
  nonce: number
}

export function WorklistSheet({
  open,
  request,
  onOpenChange,
}: {
  open: boolean
  /**
   * Kept non-null while the sheet animates closed, which is why it is a
   * separate prop from `open` rather than being derived from it.
   */
  request: WorklistRequest | null
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full bg-popover p-0 text-popover-foreground sm:max-w-md"
      >
        {request ? (
          <div className="flex h-full flex-col">
            <SheetHeader className="border-b border-border/50 p-4 pr-12">
              <SheetTitle className="truncate">{request.title}</SheetTitle>
            </SheetHeader>
            <WorklistBody key={`${request.key}:${request.nonce}`} list={request.key} />
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

interface BodyState {
  phase: 'loading' | 'ready' | 'error'
  items: WorklistItem[]
  total: number
  hasMore: boolean
  /**
   * The server clock the rows were selected against. Ages are measured
   * from it rather than from `Date.now()` during render, so every row
   * agrees with the cut-off that put it in the list.
   */
  at: Date | null
}

const INITIAL: BodyState = { phase: 'loading', items: [], total: 0, hasMore: false, at: null }

function WorklistBody({ list }: { list: WorklistKey }) {
  const t = useTranslations('Dashboard.operations.worklist')
  const format = useFormatter()
  const [state, setState] = useState<BodyState>(INITIAL)
  const [loadingMore, setLoadingMore] = useState(false)

  // `list` is fixed for the lifetime of this component (the parent keys
  // it), so this runs exactly once per open — and the state lands in the
  // promise callback, never synchronously in the effect body.
  useEffect(() => {
    let cancelled = false
    fetchWorklist(list, 0)
      .then((page) => {
        if (cancelled) return
        setState({
          phase: 'ready',
          items: page.items,
          total: page.total,
          hasMore: page.hasMore,
          at: parseInstant(page.generatedAt),
        })
      })
      .catch((err) => {
        console.error('[worklist] load failed:', err)
        if (!cancelled) setState((prev) => ({ ...prev, phase: 'error' }))
      })
    return () => {
      cancelled = true
    }
  }, [list])

  const loadMore = () => {
    setLoadingMore(true)
    fetchWorklist(list, state.items.length)
      .then((page) => {
        setState((prev) => ({
          ...prev,
          items: [...prev.items, ...page.items],
          // The totals move while somebody works the queue; the latest
          // page is the most honest count we have.
          total: page.total,
          hasMore: page.hasMore,
        }))
      })
      .catch((err) => console.error('[worklist] load more failed:', err))
      .finally(() => setLoadingMore(false))
  }

  if (state.phase === 'loading') {
    return (
      <div className="space-y-3 p-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    )
  }

  if (state.phase === 'error') {
    return (
      <p className="flex items-start gap-2 p-4 text-sm text-muted-foreground">
        <TriangleAlert className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden />
        {t('error')}
      </p>
    )
  }

  if (state.items.length === 0) {
    // The counter said there was work and the list came back empty:
    // somebody got to it between the two reads. Saying so is better than
    // an empty panel that reads as a bug.
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
        <CheckCircle2 className="h-6 w-6 text-muted-foreground" aria-hidden />
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      </div>
    )
  }

  return (
    <>
      <p className="border-b border-border/50 px-4 py-2 text-xs text-muted-foreground tabular-nums">
        {t('showing', { shown: state.items.length, total: state.total })}
      </p>

      <ul className="flex-1 divide-y divide-border/50 overflow-y-auto">
        {state.items.map((item) => (
          <li key={item.id}>
            <Link
              href={item.href}
              className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/50"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-foreground">
                  {item.title || t('noContact')}
                </span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                  {[item.contact, item.owner ?? t('unassigned')].filter(Boolean).join(' · ')}
                </span>
                {item.detail ? (
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground/70">
                    {item.detail}
                  </span>
                ) : null}
              </span>
              <span className="flex-shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums">
                {age(format, item.since, state.at) ?? t('noDate')}
              </span>
            </Link>
          </li>
        ))}
      </ul>

      {state.hasMore ? (
        <div className="border-t border-border/50 p-3">
          <button
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            {t('showMore')}
          </button>
        </div>
      ) : null}
    </>
  )
}

/**
 * How long the row has been waiting, in the reader's language. Null when
 * the row carries no instant to measure from — the caller then says so
 * rather than printing a zero that would read as "just now".
 */
function age(
  format: ReturnType<typeof useFormatter>,
  iso: string | null,
  reference: Date | null,
): string | null {
  if (!iso || !reference) return null
  const at = parseInstant(iso)
  if (!at) return null
  return format.relativeTime(at, reference)
}

function parseInstant(iso: string): Date | null {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? null : at
}
