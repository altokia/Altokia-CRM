import { describe, expect, it } from 'vitest'
import { earliestNextShift, pickAssignee, type Candidate } from './index'
import type { Availability } from '@/lib/availability'

const ok: Availability = {
  available: true, onShift: true, present: true, underCapacity: true, override: null, reasons: [],
}
const offShift: Availability = { ...ok, available: false, onShift: false, reasons: ['off_shift'] }

function cand(over: Partial<Candidate> & { userId: string }): Candidate {
  return {
    fullName: over.userId,
    department: null,
    specialties: [],
    itemIds: [],
    snapshot: {
      userId: over.userId,
      schedules: [],
      presenceAgeMinutes: 0,
      load: 0,
      capacity: 5,
      override: null,
      acceptsAssignments: true,
    },
    availability: ok,
    nextShiftStart: null,
    ...over,
  }
}

const load = (userId: string, n: number, extra: Partial<Candidate> = {}) =>
  cand({ userId, ...extra, snapshot: { ...cand({ userId }).snapshot, load: n } })

describe('pickAssignee', () => {
  it('least_load picks the lightest available advisor (Ana 3 vs Carlos 8 → Ana)', () => {
    const d = pickAssignee([load('carlos', 8), load('ana', 3)], { strategy: 'least_load' })
    expect(d.chosen?.userId).toBe('ana')
    expect(d.considered).toHaveLength(2)
  })

  it('never picks someone unavailable, and reports why', () => {
    const d = pickAssignee(
      [cand({ userId: 'a', availability: offShift }), cand({ userId: 'b', availability: offShift })],
      { strategy: 'least_load' },
    )
    expect(d.chosen).toBeNull()
    expect(d.considered.every((c) => !c.available && c.reasons.includes('off_shift'))).toBe(true)
  })

  it('the 13:00 scenario: a department hint with only an off-shift specialist yields NOBODY, not anyone', () => {
    const generalist = cand({ userId: 'gen', department: 'ventas' })
    const specialist = cand({ userId: 'spec', department: 'matriculas', availability: offShift })
    const d = pickAssignee([generalist, specialist], {
      strategy: 'by_department',
      hints: { department: 'matriculas' },
    })
    expect(d.chosen).toBeNull()
  })

  it('by_specialty and by_item filter, then least load', () => {
    const a = load('a', 2, { specialties: ['niños'] })
    const b = load('b', 1, { specialties: ['empresas'] })
    expect(pickAssignee([a, b], { strategy: 'by_specialty', hints: { specialties: ['niños'] } }).chosen?.userId).toBe('a')
    const c = load('c', 9, { itemIds: ['item-1'] })
    expect(pickAssignee([a, b, c], { strategy: 'by_item', hints: { item_id: 'item-1' } }).chosen?.userId).toBe('c')
  })

  it('previous_advisor prefers the hinted person when available, else falls back', () => {
    const prev = load('prev', 4)
    const other = load('other', 0)
    expect(
      pickAssignee([prev, other], { strategy: 'previous_advisor', hints: { previous_advisor_id: 'prev' } }).chosen?.userId,
    ).toBe('prev')
    const prevOff = cand({ userId: 'prev', availability: offShift })
    expect(
      pickAssignee([prevOff, other], { strategy: 'previous_advisor', hints: { previous_advisor_id: 'prev' } }).chosen?.userId,
    ).toBe('other')
  })

  it('round_robin rotates through available advisors using the cursor', () => {
    const ring = [cand({ userId: 'a' }), cand({ userId: 'b' }), cand({ userId: 'c' })]
    expect(pickAssignee(ring, { strategy: 'round_robin', routing: {} }).chosen?.userId).toBe('a')
    expect(pickAssignee(ring, { strategy: 'round_robin', routing: { last_assigned_user_id: 'a' } }).chosen?.userId).toBe('b')
    expect(pickAssignee(ring, { strategy: 'round_robin', routing: { last_assigned_user_id: 'c' } }).chosen?.userId).toBe('a')
    // Skips whoever is unavailable.
    const ring2 = [cand({ userId: 'a' }), cand({ userId: 'b', availability: offShift }), cand({ userId: 'c' })]
    expect(pickAssignee(ring2, { strategy: 'round_robin', routing: { last_assigned_user_id: 'a' } }).chosen?.userId).toBe('c')
  })

  it('manual never assigns; the account default applies when no strategy is given', () => {
    expect(pickAssignee([cand({ userId: 'a' })], { strategy: 'manual' }).chosen).toBeNull()
    const d = pickAssignee([cand({ userId: 'a' })], { routing: { strategy: 'round_robin' } })
    expect(d.strategy).toBe('round_robin')
    expect(d.chosen?.userId).toBe('a')
  })

  it('the default strategy honours hints and waits when they narrow to nobody', () => {
    const a = cand({ userId: 'a', department: 'ventas' })
    expect(pickAssignee([a], { hints: { department: 'soporte' } }).chosen).toBeNull()
    expect(pickAssignee([a], { hints: { department: 'ventas' } }).chosen?.userId).toBe('a')
  })
})

describe('earliestNextShift', () => {
  it('reports the soonest matching shift for the queue card', () => {
    const t1 = new Date('2026-09-03T20:00:00Z')
    const t2 = new Date('2026-09-03T23:00:00Z')
    const spec = cand({ userId: 'spec', department: 'matriculas', availability: offShift, nextShiftStart: t2 })
    const spec2 = cand({ userId: 'spec2', department: 'matriculas', availability: offShift, nextShiftStart: t1 })
    const other = cand({ userId: 'x', department: 'ventas', nextShiftStart: new Date('2026-09-03T18:00:00Z') })
    expect(earliestNextShift([spec, spec2, other], { department: 'matriculas' })).toEqual(t1)
    expect(earliestNextShift([spec], { department: 'nadie' })).toBeNull()
  })
})
