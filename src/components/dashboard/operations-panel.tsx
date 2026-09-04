"use client"

import Link from 'next/link'
import { useState } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import {
  Bot,
  ChevronRight,
  ListChecks,
  MessagesSquare,
  RefreshCw,
  TriangleAlert,
  Users,
} from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'
import type { OperationsMetrics } from '@/lib/dashboard/types'
import type { WorklistKey } from '@/lib/dashboard/worklist'
import { TASK_ACTION_TYPES } from '@/types'
import { formatCurrency } from '@/lib/currency'
import { isValidTimeZone } from '@/lib/availability'
import { useTerm } from '@/hooks/use-term'
import { cn } from '@/lib/utils'
import { ClosersBreakdown } from './closers-breakdown'
import { EmptyState } from './empty-state'
import { Skeleton } from './skeleton'
import { WorklistSheet, type WorklistRequest } from './worklist-sheet'

/**
 * Operations panel — "what needs a person right now", in four dense
 * counter cards instead of one hero tile per number. The operator scans
 * this at 9am and again after lunch; a wall of 28px numbers would push
 * the fourth block below the fold and hide exactly the row that matters.
 *
 * Nothing here is industry-specific: leads, conversations, tasks and
 * assistant activity read the same for a clinic, an agency or a shop.
 * Every word that a business would rename (won, advisor) arrives as an
 * i18n variable, never baked into a label.
 *
 * Every counter that represents pending work opens the list behind it
 * (see WorklistSheet): a red "7" that cannot be clicked tells an
 * operator that something is wrong and nothing about what to do next.
 */

/**
 * The metrics contract lives with the loader that shapes it, so the
 * panel and the query can never drift apart. Re-exported here because a
 * page that renders this panel types its state from it.
 */
export type {
  OperationsAi,
  OperationsConversations,
  OperationsLeadLabelCount,
  OperationsLeads,
  OperationsMetrics,
  OperationsTaskTypeCount,
  OperationsTasks,
} from '@/lib/dashboard/types'

interface OperationsPanelProps {
  data: OperationsMetrics | null
  loading: boolean
  /** Account default currency for the won-value line. */
  currency: string
  /** Optional manual refetch; the header control stays hidden without it. */
  onRefresh?: () => void
}

/**
 * Action types are extensible by design (types/index.ts: a business can
 * add SITE_VISIT as a constant, not a migration), so an unknown type is
 * expected traffic — it falls back to the generic label instead of
 * rendering a missing-message key.
 */
const KNOWN_ACTION_TYPES = new Set<string>(TASK_ACTION_TYPES)

export function OperationsPanel({ data, loading, currency, onRefresh }: OperationsPanelProps) {
  const t = useTranslations('Dashboard.operations')
  // The business's own word for a closed-won deal, falling back to the
  // translated default. An academy sees "Matriculado este mes" here
  // without a line of code changing.
  const tTerms = useTranslations('Terms')
  const term = useTerm()
  const format = useFormatter()

  const wonTerm = term('won', tTerms('won'))

  // Two pieces of state rather than one: `request` outlives `sheetOpen`
  // so the sheet keeps its contents while it animates closed. The nonce
  // changes on every open, which remounts the list body and re-reads it
  // — a queue that is three minutes stale is worse than no queue.
  const [request, setRequest] = useState<WorklistRequest | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)

  const openWorklist = (key: WorklistKey, title: string) => {
    setRequest((prev) => ({ key, title, nonce: (prev?.nonce ?? 0) + 1 }))
    setSheetOpen(true)
  }

  // Only worth opening when there is something in it; a counter at zero
  // stays a plain row, so a calm board has nothing to click.
  const opener = (key: WorklistKey, title: string, count: number) =>
    count > 0 ? () => openWorklist(key, title) : undefined

  // Zero-count labels say nothing in a dense card; the biggest bucket
  // first is what an operator looks for. `filter` already copies, so the
  // sort never touches the caller's array.
  const labels = (data?.leads.byLabel ?? [])
    .filter((l) => l.count > 0)
    .sort((a, b) => b.count - a.count)
  const labelTotal = labels.reduce((sum, l) => sum + l.count, 0)
  const taskTypes = (data?.tasks.byActionType ?? [])
    .slice()
    .sort((a, b) => b.count - a.count)

  const updatedTime = data ? formatClock(format, data.generatedAt, data.timezone) : null

  return (
    <section className="space-y-3">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('description')}</p>
        </div>
        <div className="flex items-center gap-3">
          {updatedTime ? (
            <span className="text-xs text-muted-foreground tabular-nums">
              {t('updated', { time: updatedTime })}
            </span>
          ) : null}
          {onRefresh ? (
            <button
              type="button"
              onClick={onRefresh}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} aria-hidden />
              {t('refresh')}
            </button>
          ) : null}
        </div>
      </header>

      {!data ? (
        // A refetch keeps the previous numbers on screen (dimmed below)
        // rather than collapsing the board back to skeletons, so only a
        // first load with nothing to show falls through to these two.
        loading ? (
          <PanelSkeleton />
        ) : (
          <EmptyState icon={TriangleAlert} title={t('empty')} />
        )
      ) : (
        <div
          className={cn(
            'grid gap-4 transition-opacity sm:grid-cols-2 xl:grid-cols-4',
            loading && 'opacity-60',
          )}
        >
          <Block
            title={t('leads.title')}
            icon={Users}
            footer={
              <>
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {t('leads.byLabel')}
                </p>
                {labels.length === 0 ? (
                  <p className="mt-1.5 text-xs text-muted-foreground">{t('leads.noLabels')}</p>
                ) : (
                  <>
                    <div className="mt-2 flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      {labels.map((l) => (
                        <span
                          key={l.key}
                          className="h-full"
                          style={{
                            width: `${(l.count / labelTotal) * 100}%`,
                            background: labelColor(l.color),
                          }}
                        />
                      ))}
                    </div>
                    <ul className="mt-2 space-y-1">
                      {labels.map((l) => (
                        <li key={l.key} className="flex items-center gap-2 text-xs">
                          <span
                            className="h-2 w-2 flex-shrink-0 rounded-full"
                            style={{ background: labelColor(l.color) }}
                            aria-hidden
                          />
                          <span className="min-w-0 flex-1 truncate text-muted-foreground">
                            {l.name}
                          </span>
                          <span className="flex-shrink-0 text-muted-foreground tabular-nums">
                            {format.number(l.count)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {/* Who closed, and whether the month is up or down. It
                    belongs under the won counter it explains, not in a
                    card of its own. */}
                <div className="mt-3 border-t border-border pt-3">
                  <ClosersBreakdown
                    timezone={data.timezone}
                    refreshKey={data.generatedAt}
                    currency={currency}
                  />
                </div>
              </>
            }
          >
            <Stat label={t('leads.newToday')} value={format.number(data.leads.newToday)} />
            <Stat label={t('leads.open')} value={format.number(data.leads.open)} />
            <Stat
              label={t('leads.highPriority')}
              value={format.number(data.leads.highPriority)}
            />
            <Stat
              label={t('leads.followUpOverdue')}
              value={format.number(data.leads.followUpOverdue)}
              alert={data.leads.followUpOverdue > 0}
              onOpen={opener(
                'lead_followups_overdue',
                t('leads.followUpOverdue'),
                data.leads.followUpOverdue,
              )}
            />
            <Stat
              label={t('leads.followUpToday')}
              value={format.number(data.leads.followUpToday)}
            />
            <Stat
              label={t('leads.wonThisMonth', { term: wonTerm })}
              value={format.number(data.leads.wonThisMonth)}
              sub={formatCurrency(data.leads.wonValueThisMonth, currency)}
            />
          </Block>

          <Block title={t('conversations.title')} icon={MessagesSquare}>
            <Stat
              label={t('conversations.waitingForHuman')}
              value={format.number(data.conversations.waitingForHuman)}
              alert={data.conversations.waitingForHuman > 0}
              onOpen={opener(
                'conversations_waiting',
                t('conversations.waitingForHuman'),
                data.conversations.waitingForHuman,
              )}
            />
            <Stat
              label={t('conversations.unassignedWaiting')}
              value={format.number(data.conversations.unassignedWaiting)}
              alert={data.conversations.unassignedWaiting > 0}
              onOpen={opener(
                'conversations_unassigned',
                t('conversations.unassignedWaiting'),
                data.conversations.unassignedWaiting,
              )}
            />
            <Stat
              label={t('conversations.aiActive')}
              value={format.number(data.conversations.aiActive)}
            />
            <Stat
              label={t('conversations.humanActive')}
              value={format.number(data.conversations.humanActive)}
            />
            <Stat
              label={t('conversations.longestWait')}
              value={
                data.conversations.longestWaitMinutes === null
                  ? t('conversations.none')
                  : t('conversations.minutes', { count: data.conversations.longestWaitMinutes })
              }
            />
          </Block>

          <Block
            title={t('tasks.title')}
            icon={ListChecks}
            footer={
              <>
                {taskTypes.length > 0 ? (
                  <>
                    <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      {t('tasks.byType')}
                    </p>
                    <ul className="mt-1.5 space-y-1">
                      {taskTypes.map((x) => (
                        <li key={x.actionType} className="flex items-center gap-2 text-xs">
                          <span className="min-w-0 flex-1 truncate text-muted-foreground">
                            {t(
                              `actionTypes.${
                                KNOWN_ACTION_TYPES.has(x.actionType) ? x.actionType : 'other'
                              }`,
                            )}
                          </span>
                          <span className="flex-shrink-0 text-muted-foreground tabular-nums">
                            {format.number(x.count)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
                <Link
                  href="/my-work"
                  className={cn(
                    'inline-block text-xs font-medium text-primary hover:text-primary/80',
                    taskTypes.length > 0 && 'mt-3',
                  )}
                >
                  {t('tasks.viewQueue')}
                </Link>
              </>
            }
          >
            <Stat label={t('tasks.open')} value={format.number(data.tasks.open)} />
            <Stat label={t('tasks.pending')} value={format.number(data.tasks.pending)} />
            <Stat
              label={t('tasks.overdue')}
              value={format.number(data.tasks.overdue)}
              alert={data.tasks.overdue > 0}
              onOpen={opener('tasks_overdue', t('tasks.overdue'), data.tasks.overdue)}
            />
            <Stat label={t('tasks.dueToday')} value={format.number(data.tasks.dueToday)} />
          </Block>

          <Block
            title={t('ai.title')}
            icon={Bot}
            footer={
              data.ai.restricted ? (
                <p className="text-xs text-muted-foreground">{t('ai.restricted')}</p>
              ) : undefined
            }
          >
            {/* Usage counters are admin-only (see OperationsAi.restricted):
                showing a zero to an agent would read as "the assistant did
                nothing", so they are withheld rather than faked. */}
            {data.ai.restricted ? null : (
              <>
                <Stat label={t('ai.repliesToday')} value={format.number(data.ai.repliesToday)} />
                <Stat
                  label={t('ai.conversationsHandledToday')}
                  value={format.number(data.ai.conversationsHandledToday)}
                />
              </>
            )}
            <Stat label={t('ai.handoffsToday')} value={format.number(data.ai.handoffsToday)} />
          </Block>
        </div>
      )}

      <WorklistSheet open={sheetOpen} request={request} onOpenChange={setSheetOpen} />
    </section>
  )
}

/**
 * One counter card. Same rounded-xl/border-border/bg-card shell as the
 * rest of the dashboard so the panel reads as part of the board and not
 * as a bolted-on widget.
 */
function Block({
  title,
  icon: Icon,
  children,
  footer,
}: {
  title: string
  icon: ComponentType<{ className?: string }>
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <div className="flex flex-col rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="h-3.5 w-3.5" />
        </span>
        <h3 className="truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h3>
      </div>
      <div className="mt-3 space-y-1.5">{children}</div>
      {footer ? <div className="mt-3 border-t border-border pt-3">{footer}</div> : null}
    </div>
  )
}

/**
 * A label/number row. `alert` is the whole point of the panel: the four
 * counters that mean "someone is waiting" turn red only when they are
 * above zero, so a calm board is genuinely calm and a red row is worth
 * walking over to.
 *
 * With `onOpen` the row becomes a button that opens the records behind
 * the number. The chevron is the only visual difference — a row that
 * looks like the others but behaves differently would be worse than no
 * affordance at all.
 */
function Stat({
  label,
  value,
  alert = false,
  sub,
  onOpen,
}: {
  label: string
  value: string
  alert?: boolean
  /** Secondary value shown to the left of the count (e.g. won value). */
  sub?: string
  /** Opens the list behind the counter. Omitted when there is nothing to open. */
  onOpen?: () => void
}) {
  const tone = alert ? 'text-red-600 dark:text-red-400' : null
  const content = (
    <>
      <span className={cn('min-w-0 truncate text-xs', tone ?? 'text-muted-foreground')}>
        {label}
      </span>
      <span className="flex flex-shrink-0 items-baseline gap-2">
        {sub ? <span className="text-[11px] text-muted-foreground tabular-nums">{sub}</span> : null}
        <span className={cn('text-sm font-semibold tabular-nums', tone ?? 'text-foreground')}>
          {value}
        </span>
        {onOpen ? (
          <ChevronRight
            className={cn(
              'h-3.5 w-3.5 self-center transition-transform group-hover:translate-x-0.5',
              tone ?? 'text-muted-foreground',
            )}
            aria-hidden
          />
        ) : null}
      </span>
    </>
  )

  if (!onOpen) {
    return <div className="flex items-baseline justify-between gap-3">{content}</div>
  }
  // The negative margin lets the hover band bleed into the card's own
  // padding, so an openable row's label still lines up with the plain
  // rows above it instead of sitting 4px in.
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group -mx-1 flex w-[calc(100%+0.5rem)] items-baseline justify-between gap-3 rounded-md px-1 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      {content}
    </button>
  )
}

function PanelSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="rounded-xl border border-border bg-card p-4">
          <Skeleton className="h-4 w-24" />
          <div className="mt-4 space-y-2">
            {Array.from({ length: 5 }).map((_, j) => (
              <Skeleton key={j} className="h-3 w-full" />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/** A hex/CSS color straight from lead_labels; blank rows fall back to the theme. */
function labelColor(color: string): string {
  return color?.trim() || 'var(--muted-foreground)'
}

/**
 * Clock stamp in the account's zone — the counters are bucketed by the
 * account's day, so showing the viewer's clock would contradict them.
 *
 * The zone is validated rather than caught: use-intl swallows a bad
 * option and returns `String(date)`, so a malformed accounts.timezone
 * would put a raw JS date in English on the panel instead of raising.
 */
function formatClock(
  format: ReturnType<typeof useFormatter>,
  iso: string,
  timeZone: string | null,
): string | null {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return null
  const zone = timeZone && isValidTimeZone(timeZone) ? timeZone : undefined
  return format.dateTime(at, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: zone,
  })
}
