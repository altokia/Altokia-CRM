/**
 * Advisor availability — pure functions, no I/O, no dependencies.
 *
 * "Is this advisor available right now?" is answered here and only
 * here, in the backend. The assistant never decides it; the routing
 * service and the shift-start job ask this module.
 *
 * Available = on shift (per their weekly schedule, in the business's
 * time zone) ∧ present (recent heartbeat) ∧ under capacity ∧ not
 * manually overridden to busy/off. A manual "available" override wins
 * over the schedule (someone covering outside their hours) but never
 * over capacity.
 *
 * Time zones use the platform's Intl — no library — because all we
 * need is the business's wall clock for a given instant. Peru has no
 * DST, but the logic is DST-correct anyway since Intl does the math.
 */

/** 0 = Sunday … 6 = Saturday, matching JavaScript's Date#getDay(). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

export interface ScheduleWindow {
  weekday: Weekday
  /** 'HH:mm', 24h, in the business time zone. */
  start: string
  /** 'HH:mm', exclusive. Must be later than start (no overnight in v1). */
  end: string
}

export type AvailabilityOverride = 'available' | 'busy' | 'off' | null

export interface AdvisorSnapshot {
  userId: string
  schedules: ScheduleWindow[]
  /** Minutes since the last presence heartbeat; null = never seen. */
  presenceAgeMinutes: number | null
  /** Conversations currently owned + tasks in progress. */
  load: number
  capacity: number
  override: AvailabilityOverride
  acceptsAssignments: boolean
}

export interface Availability {
  available: boolean
  onShift: boolean
  present: boolean
  underCapacity: boolean
  override: AvailabilityOverride
  /** Human-readable, machine-stable reasons when not available. */
  reasons: Array<'off_shift' | 'offline' | 'at_capacity' | 'override_busy' | 'override_off' | 'not_accepting'>
}

/** A presence heartbeat older than this counts as offline (mirrors lib/presence OFFLINE_AFTER_MS ≈ 75s, generously). */
export const PRESENCE_STALE_MINUTES = 3

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

export function parseHHMM(value: string): number {
  const m = HHMM.exec(value)
  if (!m) throw new Error(`Invalid time "${value}", expected HH:mm`)
  return Number(m[1]) * 60 + Number(m[2])
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/**
 * The business's wall clock for an instant: weekday and minutes since
 * midnight, in `timeZone`.
 */
export function localClock(now: Date, timeZone: string): { weekday: Weekday; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  const weekdayIndex: Record<string, Weekday> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  }
  const weekday = weekdayIndex[get('weekday')]
  if (weekday === undefined) throw new Error(`Unexpected weekday from Intl for zone ${timeZone}`)
  return { weekday, minutes: Number(get('hour')) * 60 + Number(get('minute')) }
}

/**
 * True when `now` (in `timeZone`) falls inside any of the windows.
 *
 * No windows at all means "no restriction", not "never": a team that
 * has not configured schedules yet must still receive assignments on
 * day one. Presence and capacity still apply.
 */
export function isOnShift(schedules: ScheduleWindow[], now: Date, timeZone: string): boolean {
  if (schedules.length === 0) return true
  const { weekday, minutes } = localClock(now, timeZone)
  return schedules.some(
    (w) => w.weekday === weekday && parseHHMM(w.start) <= minutes && minutes < parseHHMM(w.end),
  )
}

export function computeAvailability(advisor: AdvisorSnapshot, now: Date, timeZone: string): Availability {
  const onShift = isOnShift(advisor.schedules, now, timeZone)
  const present =
    advisor.presenceAgeMinutes !== null && advisor.presenceAgeMinutes <= PRESENCE_STALE_MINUTES
  const underCapacity = advisor.load < advisor.capacity
  const reasons: Availability['reasons'] = []

  if (!advisor.acceptsAssignments) reasons.push('not_accepting')
  if (advisor.override === 'off') reasons.push('override_off')
  if (advisor.override === 'busy') reasons.push('override_busy')
  if (!underCapacity) reasons.push('at_capacity')

  // A manual "available" stands in for the schedule and the heartbeat:
  // it is the advisor saying "I'm here" from outside their hours or
  // from a device that isn't sending presence.
  const coveringManually = advisor.override === 'available'
  if (!coveringManually) {
    if (!onShift) reasons.push('off_shift')
    if (!present) reasons.push('offline')
  }

  return {
    available: reasons.length === 0,
    onShift,
    present,
    underCapacity,
    override: advisor.override,
    reasons,
  }
}

/**
 * The next instant at or after `now` when any window opens (or `now`
 * itself if a window is open). Scans a week ahead; null if the advisor
 * has no schedule at all.
 *
 * Used by the queue card ("disponible desde las 15:00") and by the
 * shift-start job to know it has work to do. Without a schedule the
 * advisor is unrestricted, so the answer is `now`.
 */
export function nextShiftStart(schedules: ScheduleWindow[], now: Date, timeZone: string): Date | null {
  if (isOnShift(schedules, now, timeZone)) return now

  // Walk minute by minute would be silly; walk day by day and pick the
  // earliest window start after the local clock on that day.
  const { weekday: today, minutes: nowMin } = localClock(now, timeZone)
  for (let offset = 0; offset < 7; offset++) {
    const weekday = ((today + offset) % 7) as Weekday
    const starts = schedules
      .filter((w) => w.weekday === weekday)
      .map((w) => parseHHMM(w.start))
      .filter((m) => offset > 0 || m > nowMin)
      .sort((a, b) => a - b)
    if (starts.length === 0) continue
    return atLocalTime(now, timeZone, offset, starts[0])
  }
  return null
}

/**
 * Build the instant that is `dayOffset` days after `now` at `minutes`
 * past midnight in `timeZone`. Done by reading the zone offset from
 * Intl for the target day, which keeps it right across DST changes.
 */
function atLocalTime(now: Date, timeZone: string, dayOffset: number, minutes: number): Date {
  // Start from the target day's local midnight expressed in UTC.
  const target = new Date(now.getTime() + dayOffset * 86_400_000)
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(target) // YYYY-MM-DD
  const naiveUtc = new Date(`${ymd}T${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00Z`)
  // naiveUtc is "that wall time as if UTC"; shift by the zone offset at that moment.
  const offsetMin = zoneOffsetMinutes(naiveUtc, timeZone)
  return new Date(naiveUtc.getTime() - offsetMin * 60_000)
}

/** Minutes east of UTC for `timeZone` at instant `date` (e.g. Lima = -300). */
export function zoneOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return Math.round((asUtc - date.getTime()) / 60_000)
}
