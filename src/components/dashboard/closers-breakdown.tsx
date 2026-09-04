"use client"

import { useEffect, useState } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { ArrowDown, ArrowUp, Minus } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { formatCurrency } from '@/lib/currency'
import { CLOSERS_ROW_CAP, loadClosers, type ClosersSummary } from '@/lib/dashboard/closers'
import { cn } from '@/lib/utils'
import { Skeleton } from './skeleton'

/**
 * Who closed this month, and whether the month is going better or worse
 * than the last one.
 *
 * The panel already showed how much was won this month. That number
 * alone answers neither of the two questions an owner actually asks at
 * month end — who did it, and are we up or down — so both are added
 * here, under the counter they belong to.
 *
 * The comparison follows MetricCard's delta pattern (arrow + tone) so a
 * good month and a bad one read the same way everywhere on the board.
 */

/** Advisors listed before the tail collapses into a "+N more" line. */
const MAX_ROWS = 6

interface State {
  phase: 'loading' | 'ready' | 'error'
  summary: ClosersSummary | null
}

export function ClosersBreakdown({
  timezone,
  refreshKey,
  currency,
}: {
  /** accounts.timezone, as the 044 RPC resolved it. Bounds both months. */
  timezone: string
  /**
   * Changes whenever the panel re-reads its counters (the RPC's
   * `generated_at`), which is what makes the refresh button refresh this
   * block too.
   */
  refreshKey: string
  /** Account default currency, same one the won-value line uses. */
  currency: string
}) {
  const t = useTranslations('Dashboard.operations.closers')
  const [state, setState] = useState<State>({ phase: 'loading', summary: null })

  useEffect(() => {
    let cancelled = false
    // `refreshKey` is the RPC's generated_at, i.e. the same instant the
    // counters above were measured at. Bounding the months with it
    // rather than the browser clock is what keeps this breakdown from
    // disagreeing with the "closed this month" counter beside it when a
    // laptop's clock drifts or a tab has been open across midnight.
    const at = new Date(refreshKey)
    loadClosers(createClient(), timezone, Number.isNaN(at.getTime()) ? undefined : at)
      .then((summary) => {
        if (!cancelled) setState({ phase: 'ready', summary })
      })
      .catch((err) => {
        console.error('[dashboard] closers failed:', err)
        // Keep whatever is already on screen: a failed refresh should
        // dim the block, not blank it.
        if (!cancelled) setState((prev) => ({ phase: 'error', summary: prev.summary }))
      })
    return () => {
      cancelled = true
    }
  }, [timezone, refreshKey])

  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {t('title')}
      </p>

      {state.summary === null ? (
        state.phase === 'loading' ? (
          <div className="mt-2 space-y-1.5">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-3 w-28" />
          </div>
        ) : (
          <p className="mt-1.5 text-xs text-muted-foreground">{t('unavailable')}</p>
        )
      ) : (
        <Summary
          summary={state.summary}
          currency={currency}
          stale={state.phase === 'error'}
        />
      )}
    </div>
  )
}

function Summary({
  summary,
  currency,
  stale,
}: {
  summary: ClosersSummary
  currency: string
  /** True when the last refresh failed and these numbers are the old ones. */
  stale: boolean
}) {
  const t = useTranslations('Dashboard.operations.closers')
  const format = useFormatter()

  const deltaCount = summary.current.count - summary.previous.count
  const deltaValue = summary.current.value - summary.previous.value
  // The count leads: "three more deals" is the sentence, and the money
  // only breaks the tie when the same number of deals closed for more.
  const sign = deltaCount !== 0 ? Math.sign(deltaCount) : Math.sign(deltaValue)
  const Arrow = sign > 0 ? ArrowUp : sign < 0 ? ArrowDown : Minus

  const rows = summary.byAdvisor.slice(0, MAX_ROWS)
  const rest = summary.byAdvisor.length - rows.length

  return (
    <div className={cn('mt-1.5', stale && 'opacity-60')}>
      <div
        className={cn(
          'flex items-center gap-1 text-xs',
          sign > 0
            ? 'text-primary'
            : sign < 0
              ? 'text-red-600 dark:text-red-400'
              : 'text-muted-foreground',
        )}
      >
        <Arrow className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
        <span className="tabular-nums">
          {sign === 0
            ? t('sameAsLastMonth')
            : t('vsLastMonth', {
                count: signedNumber(format, deltaCount),
                value: signedCurrency(deltaValue, currency),
              })}
        </span>
      </div>

      {summary.byAdvisor.length === 0 ? (
        <p className="mt-1.5 text-xs text-muted-foreground">{t('none')}</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {rows.map((row) => (
            <li key={row.profileId ?? 'unassigned'} className="flex items-center gap-2 text-xs">
              {/* A deal nobody owns is named as such — guessing an owner
                  would put a sale on the wrong person's record. */}
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {row.name ?? t('unassigned')}
              </span>
              <span className="flex-shrink-0 text-[11px] text-muted-foreground tabular-nums">
                {formatCurrency(row.value, currency)}
              </span>
              <span className="flex-shrink-0 font-medium text-foreground tabular-nums">
                {format.number(row.count)}
              </span>
            </li>
          ))}
          {rest > 0 ? (
            <li className="text-xs text-muted-foreground tabular-nums">{t('more', { count: rest })}</li>
          ) : null}
        </ul>
      )}

      {summary.partial ? (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          {t('partial', { count: CLOSERS_ROW_CAP })}
        </p>
      ) : null}
    </div>
  )
}

/** "+3" / "-1" — the sign carries the meaning, so it is never dropped. */
function signedNumber(format: ReturnType<typeof useFormatter>, delta: number): string {
  return `${delta > 0 ? '+' : ''}${format.number(delta)}`
}

function signedCurrency(delta: number, currency: string): string {
  return `${delta > 0 ? '+' : ''}${formatCurrency(delta, currency)}`
}
