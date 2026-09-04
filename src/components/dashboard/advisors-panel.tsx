"use client"

import Link from 'next/link'
import { useFormatter, useTranslations } from 'next-intl'
import { TriangleAlert } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { isValidTimeZone } from '@/lib/availability'
import { useTerm } from '@/hooks/use-term'
import { cn } from '@/lib/utils'
import { Skeleton } from './skeleton'

/**
 * Advisors panel — who can pick up work right now, and if nobody can,
 * saying so out loud. "Nobody is available" is the single most useful
 * thing this widget can tell a business (it is why an inbox fills up at
 * 13:00 with nobody noticing), so it gets its own banner instead of
 * being left as an empty list the eye skips over.
 */

/**
 * The row GET /api/account/advisors returns, snake_case and all. It is
 * re-declared here on purpose: a client component must not import from
 * a route handler, and the API shape is the contract we render.
 */
export interface AdvisorRow {
  user_id: string
  full_name: string
  avatar_url: string | null
  availability: {
    available: boolean
    onShift: boolean
    present: boolean
    underCapacity: boolean
    /** Machine-stable codes from lib/availability; see STATUS_BY_REASON. */
    reasons: string[]
  }
  next_shift_start: string | null
  load: number
}

type StatusKey = 'available' | 'offShift' | 'busy' | 'offline' | 'atCapacity'

/**
 * Reasons come out of computeAvailability most-deliberate-first (a
 * manual override before the schedule before the heartbeat), so the
 * first one is the one worth showing — same rule the settings list
 * uses. The set is extensible, so an unrecognised reason degrades to
 * "off shift" rather than rendering a raw code at the operator.
 */
const STATUS_BY_REASON: Record<string, StatusKey> = {
  off_shift: 'offShift',
  override_off: 'offShift',
  offline: 'offline',
  at_capacity: 'atCapacity',
  override_busy: 'busy',
  not_accepting: 'busy',
}

const STATUS_TONE: Record<StatusKey, string> = {
  available: 'bg-primary/10 text-primary',
  busy: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  atCapacity: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  offShift: 'bg-muted text-muted-foreground',
  offline: 'bg-muted text-muted-foreground',
}

export function AdvisorsPanel({
  advisors,
  loading,
  timezone,
}: {
  advisors: AdvisorRow[] | null
  loading: boolean
  /**
   * The account's IANA zone. Shifts are defined in it, so "entra a las
   * 15:00" has to be rendered in it — a manager in another zone reading
   * their own clock would go looking for the wrong person.
   */
  timezone?: string | null
}) {
  const t = useTranslations('Dashboard.advisors')
  // The business's own word for the people who take work: "Asesores",
  // "Vendedores", "Doctores". Falls back to the translation.
  const tTerms = useTranslations('Terms')
  const term = useTerm()
  const format = useFormatter()

  const advisorsTerm = term('advisors', tTerms('advisors'))
  const zone = timezone && isValidTimeZone(timezone) ? timezone : undefined

  // Whoever can take the next chat goes on top, and among those the
  // least loaded — the same order the router itself would pick in.
  const rows = [...(advisors ?? [])].sort(
    (a, b) =>
      Number(b.availability.available) - Number(a.availability.available) ||
      a.load - b.load ||
      a.full_name.localeCompare(b.full_name),
  )
  const availableCount = rows.filter((r) => r.availability.available).length

  return (
    <section className="flex h-full flex-col rounded-xl border border-border bg-card">
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-foreground">
            {t('title', { term: advisorsTerm })}
          </h2>
          {advisors ? (
            <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
              {t('summary', { available: availableCount, total: rows.length })}
            </p>
          ) : null}
        </div>
        <Link
          href="/settings?tab=members"
          className="flex-shrink-0 text-xs font-medium text-primary hover:text-primary/80"
        >
          {t('viewTeam')}
        </Link>
      </header>

      {!advisors ? (
        // Never claim "nobody is available" from a list we don't have:
        // that banner is a statement about the team, not about a failed
        // fetch. A refetch keeps the rows we already show.
        loading ? (
          <div className="space-y-2 p-5">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : (
          // Loading finished and still nothing: the fetch failed. Saying
          // so beats an empty card that reads as "no team configured".
          <p className="flex items-center gap-2 px-5 py-4 text-xs text-muted-foreground">
            <TriangleAlert className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
            {t('unavailable')}
          </p>
        )
      ) : (
        <>
          {availableCount === 0 ? (
            <p className="border-b border-border bg-amber-500/10 px-5 py-2.5 text-xs font-medium text-amber-700 dark:text-amber-400">
              {t('nobody')}
            </p>
          ) : null}
          <ul className="divide-y divide-border">
            {rows.map((a) => {
              const status: StatusKey = a.availability.available
                ? 'available'
                : (STATUS_BY_REASON[a.availability.reasons[0]] ?? 'offShift')
              // Only worth saying when they can't help now: the point is
              // "come back at 15:00", not a roster.
              const nextShift =
                !a.availability.available && a.next_shift_start
                  ? formatShiftStart(format, a.next_shift_start, zone)
                  : null
              return (
                <li key={a.user_id} className="flex items-center gap-3 px-5 py-2.5">
                  <Avatar size="sm" className="flex-shrink-0">
                    {a.avatar_url ? <AvatarImage src={a.avatar_url} alt={a.full_name} /> : null}
                    <AvatarFallback>{initials(a.full_name)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-foreground">{a.full_name}</p>
                    {nextShift ? (
                      <p className="truncate text-xs text-muted-foreground tabular-nums">
                        {t('nextShift', { time: nextShift })}
                      </p>
                    ) : null}
                  </div>
                  <span
                    className={cn(
                      'flex-shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium',
                      STATUS_TONE[status],
                    )}
                  >
                    {t(status)}
                  </span>
                  <span className="flex-shrink-0 text-xs text-muted-foreground tabular-nums">
                    {t('load', { count: a.load })}
                  </span>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </section>
  )
}

/**
 * Weekday + clock, never a bare hour: the next window can open tomorrow
 * and "09:00" alone would read as "in a few minutes". Deliberately not
 * a relative time — that would need `now` during render.
 */
function formatShiftStart(
  format: ReturnType<typeof useFormatter>,
  iso: string,
  timeZone: string | undefined,
): string | null {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return null
  // The zone is validated by the caller rather than caught here:
  // use-intl swallows a bad option and returns String(date), so an
  // invalid zone would print a raw JS date instead of throwing.
  return format.dateTime(at, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  })
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  const last = parts.length > 1 ? parts[parts.length - 1][0] : ''
  return (parts[0][0] + last).toUpperCase()
}
