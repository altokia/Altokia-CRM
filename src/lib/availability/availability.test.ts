import { describe, expect, it } from 'vitest'
import {
  computeAvailability,
  isOnShift,
  localClock,
  nextShiftStart,
  parseHHMM,
  zoneOffsetMinutes,
  type AdvisorSnapshot,
  type ScheduleWindow,
} from './index'

// The acceptance scenario from the plan: three advisors in Lima with
// shifts 09-14, 15-17 and 18-22; a lead arrives at 13:00.
const LIMA = 'America/Lima'
// 2026-09-03 is a Thursday (weekday 4). 13:00 Lima = 18:00Z (UTC-5, no DST).
const THU_1300_LIMA = new Date('2026-09-03T18:00:00Z')
const THU_1500_LIMA = new Date('2026-09-03T20:00:00Z')
const THU_1900_LIMA = new Date('2026-09-04T00:00:00Z')

const weekdays = [1, 2, 3, 4, 5] as const
const shift = (start: string, end: string): ScheduleWindow[] =>
  weekdays.map((weekday) => ({ weekday, start, end }))

const advisor = (over: Partial<AdvisorSnapshot>): AdvisorSnapshot => ({
  userId: 'u',
  schedules: [],
  presenceAgeMinutes: 0,
  load: 0,
  capacity: 5,
  override: null,
  acceptsAssignments: true,
  ...over,
})

describe('localClock', () => {
  it('reads the business wall clock, not the server clock', () => {
    expect(localClock(THU_1300_LIMA, LIMA)).toEqual({ weekday: 4, minutes: 13 * 60 })
    // Same instant is 20:00 in Madrid (CEST, UTC+2) — a different day would be a different weekday.
    expect(localClock(THU_1300_LIMA, 'Europe/Madrid')).toEqual({ weekday: 4, minutes: 20 * 60 })
    // 19:00 Lima is already Friday 00:00 UTC; the weekday must still be Thursday in Lima.
    expect(localClock(THU_1900_LIMA, LIMA)).toEqual({ weekday: 4, minutes: 19 * 60 })
  })
})

describe('isOnShift', () => {
  it('matches the 13:00 / 15:00 / 19:00 scenario', () => {
    const morning = shift('09:00', '14:00')
    const afternoon = shift('15:00', '17:00')
    const evening = shift('18:00', '22:00')
    expect(isOnShift(morning, THU_1300_LIMA, LIMA)).toBe(true)
    expect(isOnShift(afternoon, THU_1300_LIMA, LIMA)).toBe(false)
    expect(isOnShift(evening, THU_1300_LIMA, LIMA)).toBe(false)

    expect(isOnShift(afternoon, THU_1500_LIMA, LIMA)).toBe(true)
    expect(isOnShift(evening, THU_1900_LIMA, LIMA)).toBe(true)
    expect(isOnShift(morning, THU_1900_LIMA, LIMA)).toBe(false)
  })

  it('treats the end as exclusive and honours weekdays', () => {
    const w = shift('15:00', '17:00')
    expect(isOnShift(w, new Date('2026-09-03T22:00:00Z'), LIMA)).toBe(false) // 17:00 exactly
    expect(isOnShift(w, new Date('2026-09-03T21:59:00Z'), LIMA)).toBe(true) // 16:59
    // Saturday 15:30 Lima — no weekend window.
    expect(isOnShift(w, new Date('2026-09-05T20:30:00Z'), LIMA)).toBe(false)
  })

  it('treats "no schedule configured" as unrestricted, not as never', () => {
    // Day one: nobody has set shifts yet, assignments must still flow.
    expect(isOnShift([], THU_1300_LIMA, LIMA)).toBe(true)
  })
})

describe('computeAvailability', () => {
  it('is available only when on shift, present and under capacity', () => {
    const a = computeAvailability(advisor({ schedules: shift('15:00', '17:00') }), THU_1500_LIMA, LIMA)
    expect(a.available).toBe(true)
    expect(a.reasons).toEqual([])
  })

  it('explains each way of being unavailable', () => {
    const base = { schedules: shift('15:00', '17:00') }
    expect(computeAvailability(advisor(base), THU_1300_LIMA, LIMA).reasons).toEqual(['off_shift'])
    // No roster: the heartbeat is the only evidence anyone is working.
    expect(computeAvailability(advisor({ schedules: [], presenceAgeMinutes: 10 }), THU_1500_LIMA, LIMA).reasons).toEqual(['offline'])
    expect(computeAvailability(advisor({ schedules: [], presenceAgeMinutes: null }), THU_1500_LIMA, LIMA).reasons).toEqual(['offline'])
    expect(computeAvailability(advisor({ ...base, load: 5 }), THU_1500_LIMA, LIMA).reasons).toEqual(['at_capacity'])
    expect(computeAvailability(advisor({ ...base, override: 'busy' }), THU_1500_LIMA, LIMA).reasons).toEqual(['override_busy'])
    expect(computeAvailability(advisor({ ...base, override: 'off' }), THU_1500_LIMA, LIMA).reasons).toEqual(['override_off'])
    expect(computeAvailability(advisor({ ...base, acceptsAssignments: false }), THU_1500_LIMA, LIMA).reasons).toEqual(['not_accepting'])
  })

  it('the roster outranks the heartbeat: on shift with the tab closed still counts', () => {
    // The failure this encodes: an advisor working the 15:00 shift from
    // their phone used to read as offline, so routing skipped everyone
    // and the queue grew with the schedule configured perfectly.
    const onShiftNoTab = advisor({
      schedules: shift('15:00', '17:00'),
      presenceAgeMinutes: null,
    })
    const state = computeAvailability(onShiftNoTab, THU_1500_LIMA, LIMA)
    expect(state.available).toBe(true)
    expect(state.reasons).toEqual([])
    // The signal survives for the team screen, it just does not veto.
    expect(state.present).toBe(false)
    expect(state.onShift).toBe(true)
  })

  it('off shift is still off shift, heartbeat or not', () => {
    const off = advisor({ schedules: shift('15:00', '17:00'), presenceAgeMinutes: 0 })
    expect(computeAvailability(off, THU_1300_LIMA, LIMA).reasons).toEqual(['off_shift'])
  })

  it('a manual "available" covers outside the shift but never over capacity', () => {
    const covering = advisor({ schedules: shift('15:00', '17:00'), override: 'available', presenceAgeMinutes: null })
    expect(computeAvailability(covering, THU_1300_LIMA, LIMA).available).toBe(true)
    expect(computeAvailability({ ...covering, load: 5 }, THU_1300_LIMA, LIMA).reasons).toEqual(['at_capacity'])
  })
})

describe('nextShiftStart', () => {
  it('returns now when a window is open', () => {
    expect(nextShiftStart(shift('09:00', '14:00'), THU_1300_LIMA, LIMA)).toEqual(THU_1300_LIMA)
  })

  it('finds 15:00 today for the afternoon specialist asked at 13:00', () => {
    const next = nextShiftStart(shift('15:00', '17:00'), THU_1300_LIMA, LIMA)
    expect(next?.toISOString()).toBe('2026-09-03T20:00:00.000Z')
  })

  it('rolls over to the next scheduled day', () => {
    // Asked Thursday 19:00 Lima about a 15-17 shift → Friday 15:00 Lima = Friday 20:00Z.
    const next = nextShiftStart(shift('15:00', '17:00'), THU_1900_LIMA, LIMA)
    expect(next?.toISOString()).toBe('2026-09-04T20:00:00.000Z')
    // Asked Friday 19:00 → Monday 15:00 (skips the weekend).
    const fri = new Date('2026-09-05T00:00:00Z')
    expect(nextShiftStart(shift('15:00', '17:00'), fri, LIMA)?.toISOString()).toBe('2026-09-07T20:00:00.000Z')
  })

  it('is "now" without a schedule (unrestricted)', () => {
    expect(nextShiftStart([], THU_1300_LIMA, LIMA)).toEqual(THU_1300_LIMA)
  })
})

describe('helpers', () => {
  it('parses HH:mm strictly', () => {
    expect(parseHHMM('09:05')).toBe(545)
    expect(() => parseHHMM('9:05')).toThrow()
    expect(() => parseHHMM('24:00')).toThrow()
  })

  it('reads zone offsets including DST zones', () => {
    expect(zoneOffsetMinutes(THU_1300_LIMA, LIMA)).toBe(-300)
    expect(zoneOffsetMinutes(THU_1300_LIMA, 'Europe/Madrid')).toBe(120)
    expect(zoneOffsetMinutes(new Date('2026-01-15T12:00:00Z'), 'Europe/Madrid')).toBe(60)
  })
})
