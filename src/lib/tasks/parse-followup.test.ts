import { describe, expect, it } from 'vitest'
import { parseFollowUp } from './parse-followup'

// Thursday 2026-09-03, 15:00 in Lima (UTC-5, no DST).
const NOW = new Date('2026-09-03T20:00:00.000Z')
const TZ = 'America/Lima'
const parse = (text: string) => parseFollowUp(text, { now: NOW, timeZone: TZ })

describe('parseFollowUp — when', () => {
  it('reads "mañana" as tomorrow at the default hour', () => {
    const r = parse('recuérdame mañana llamar a Juan')
    expect(r?.dueAt.toISOString()).toBe('2026-09-04T14:00:00.000Z')
    expect(r?.hasTime).toBe(false)
  })

  it('reads a bare afternoon hour as 15:00', () => {
    const r = parse('mañana a las 3 llamar a Juan')
    expect(r?.dueAt.toISOString()).toBe('2026-09-04T20:00:00.000Z')
    expect(r?.hasTime).toBe(true)
  })

  it('reads "en 2 horas" relative to now', () => {
    expect(parse('en 2 horas enviar la cotización')?.dueAt.toISOString()).toBe('2026-09-03T22:00:00.000Z')
    expect(parse('en 30 minutos revisar')?.dueAt.toISOString()).toBe('2026-09-03T20:30:00.000Z')
    expect(parse('en media hora')?.dueAt.toISOString()).toBe('2026-09-03T20:30:00.000Z')
  })

  it('reads "en 3 días" as a day offset with the default hour', () => {
    expect(parse('en 3 días confirmar')?.dueAt.toISOString()).toBe('2026-09-06T14:00:00.000Z')
  })

  it('reads a weekday as the next occurrence', () => {
    expect(parse('el lunes a las 10am')?.dueAt.toISOString()).toBe('2026-09-07T15:00:00.000Z')
    // Today is Thursday: "el jueves" means next week.
    expect(parse('el jueves')?.dueAt.toISOString()).toBe('2026-09-10T14:00:00.000Z')
  })

  it('reads a night hour today when it is still ahead', () => {
    expect(parse('a las 8 de la noche')?.dueAt.toISOString()).toBe('2026-09-04T01:00:00.000Z')
  })

  it('pushes a passed time-only reminder to tomorrow', () => {
    expect(parse('a las 10 confirmar')?.dueAt.toISOString()).toBe('2026-09-04T15:00:00.000Z')
    expect(parse('en la mañana')?.dueAt.toISOString()).toBe('2026-09-04T14:00:00.000Z')
  })

  it('reads named and numeric dates, rolling to next year when past', () => {
    expect(parse('el 15 de septiembre a las 4pm')?.dueAt.toISOString()).toBe('2026-09-15T21:00:00.000Z')
    expect(parse('el 1 de enero')?.dueAt.toISOString()).toBe('2027-01-01T14:00:00.000Z')
    expect(parse('15/09 llamar')?.dueAt.toISOString()).toBe('2026-09-15T14:00:00.000Z')
  })

  it('reads "hoy a la 1" as 13:00 today and "pasado mañana"', () => {
    expect(parse('hoy a la 1')?.dueAt.toISOString()).toBe('2026-09-03T18:00:00.000Z')
    expect(parse('pasado mañana')?.dueAt.toISOString()).toBe('2026-09-05T14:00:00.000Z')
  })

  it('reads the basic English forms', () => {
    const r = parse('remind me tomorrow at 9:30 to send the invoice')
    expect(r?.dueAt.toISOString()).toBe('2026-09-04T14:30:00.000Z')
    expect(r?.title).toBe('Send the invoice')
  })

  it('returns null without any time words', () => {
    expect(parse('llamar a Juan')).toBeNull()
    expect(parse('')).toBeNull()
  })
})

describe('parseFollowUp — what', () => {
  it('strips the command and the time words, keeping the rest as the title', () => {
    const r = parse('recuérdame mañana llamar a Juan')
    expect(r?.title).toBe('Llamar a Juan')
    expect(r?.personHint).toBe('Juan')
  })

  it('keeps accents and casing of the remaining text', () => {
    expect(parse('Mañana a las 10 enviar la cotización a Sofía')?.title).toBe('Enviar la cotización a Sofía')
    expect(parse('Mañana a las 10 enviar la cotización a Sofía')?.personHint).toBe('Sofía')
  })

  it('falls back to a default title when only time words were typed', () => {
    expect(parse('hoy a la 1')?.title).toBe('Seguimiento')
    expect(parseFollowUp('mañana', { now: NOW, timeZone: TZ, fallbackTitle: 'Follow-up' })?.title).toBe('Follow-up')
  })

  it('does not take a weekday for a person', () => {
    expect(parse('el Lunes llamar')?.personHint).toBeNull()
  })
})
