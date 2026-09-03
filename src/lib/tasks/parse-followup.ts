/**
 * "Recuérdame mañana a las 10 llamar a Juan" → when, and what.
 *
 * A small deterministic parser for the way a sales team writes
 * reminders in Spanish (plus the basic English forms), so a follow-up
 * can be typed in one line from the inbox or "Mi trabajo" without a
 * date picker. No model call: the moment is computed here, in the
 * account's time zone, and whatever is left once the time words are
 * removed becomes the task title.
 *
 * Understood: hoy / mañana / pasado mañana · en N minutos|horas|días|
 * semanas · el lunes … domingo (next occurrence) · el 15 de septiembre
 * · 15/09 · a las 10, a la 1, a las 3:30, 4pm, a las 8 de la noche ·
 * en la mañana|tarde|noche · al mediodía · a primera hora. A bare hour
 * from 1 to 6 is read as afternoon (business hours); a day with no
 * hour uses `defaultHour`.
 */

import { zoneOffsetMinutes } from '@/lib/availability'

export interface ParsedFollowUp {
  dueAt: Date
  title: string
  /** A capitalised name after "a"/"con" ("llamar a Juan" → "Juan"), if any. */
  personHint: string | null
  /** True when the text carried a clock time (vs. the default hour). */
  hasTime: boolean
}

export interface ParseFollowUpOptions {
  now: Date
  timeZone: string
  /** Hour used when only a day was given. Default 9. */
  defaultHour?: number
  /** Title when nothing but the time words was typed. */
  fallbackTitle?: string
}

const WEEKDAYS_ES = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado']
const WEEKDAYS_EN = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']
const MONTHS_EN = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

const NUMBER_WORDS: Record<string, number> = {
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  quince: 15, veinte: 20, treinta: 30, media: 0.5,
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, half: 0.5,
}

const DAY_PART_HOUR: Record<string, number> = {
  manana: 9, morning: 9,
  tarde: 15, afternoon: 15,
  noche: 19, evening: 19, tonight: 19,
}

type Meridiem = 'am' | 'pm' | null

export function parseFollowUp(text: string, opts: ParseFollowUpOptions): ParsedFollowUp | null {
  const { now, timeZone } = opts
  const defaultHour = opts.defaultHour ?? 9

  // `work` is a folded (lower-case, accent-less, same-length) copy that
  // gets blanked as pieces are recognised, so later patterns cannot
  // re-read what an earlier one consumed, and so the same spans can be
  // cut out of the original text for the title.
  let work = fold(text)
  const spans: Array<[number, number]> = []
  const find = (re: RegExp): RegExpExecArray | null => {
    const m = re.exec(work)
    if (!m) return null
    const start = m.index
    const end = start + m[0].length
    spans.push([start, end])
    work = work.slice(0, start) + ' '.repeat(end - start) + work.slice(end)
    return m
  }

  // --- 1. "en 2 horas" / "in 3 days" -----------------------------------
  let exactDelta: number | null = null
  let dayOffset: number | null = null
  const rel = find(
    /\b(?:en|dentro\s+de|in)\s+(\d+|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|quince|veinte|treinta|media|a|an|one|two|three|four|five|six|seven|eight|nine|ten|half)\s+(minutos?|minutes?|mins?|horas?|hours?|hrs?|h|dias?|days?|semanas?|weeks?)\b/,
  )
  if (rel) {
    const qty = /^\d+$/.test(rel[1]) ? parseInt(rel[1], 10) : (NUMBER_WORDS[rel[1]] ?? 1)
    const unit = rel[2]
    if (/^(min|minuto|minute)/.test(unit)) exactDelta = qty * 60_000
    else if (/^(h|hora|hour|hr)/.test(unit)) exactDelta = qty * 3_600_000
    else if (/^(dia|day)/.test(unit)) dayOffset = Math.round(qty)
    else dayOffset = Math.round(qty * 7)
  }

  // --- 2. Day parts: "en la tarde", "de la mañana", "al mediodía" -------
  let dayPartHour: number | null = null
  let dayPartMeridiem: Meridiem = null
  const part = find(
    /\b(?:en|por|a|de)\s+la\s+(manana|tarde|noche)\b|\b(?:in\s+the|this)\s+(morning|afternoon|evening)\b|\b(tonight)\b|\ba\s+primera\s+hora\b|\b(?:al|a)\s+mediodia\b|\bnoon\b/,
  )
  if (part) {
    const word = part[1] ?? part[2] ?? part[3] ?? null
    if (word) {
      dayPartHour = DAY_PART_HOUR[word]
      dayPartMeridiem = word === 'manana' || word === 'morning' ? 'am' : 'pm'
    } else if (/primera/.test(part[0])) {
      dayPartHour = 8
      dayPartMeridiem = 'am'
    } else {
      dayPartHour = 12
    }
  }

  // --- 3. Clock time ----------------------------------------------------
  let time: { hour: number; minute: number } | null = null
  const clock =
    find(/\b(?:a\s+las?|at|@)\s*(\d{1,2})(?:[:.h](\d{2}))?\s*(am|pm|a\.\s?m\.?|p\.\s?m\.?|hrs?\.?|horas)?/) ??
    find(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.\s?m\.?|p\.\s?m\.?)\b/)
  if (clock) {
    const rawHour = parseInt(clock[1], 10)
    const minute = clock[2] ? parseInt(clock[2], 10) : 0
    const suffix = (clock[3] ?? '').replace(/[\s.]/g, '')
    const meridiem: Meridiem = suffix === 'am' ? 'am' : suffix === 'pm' ? 'pm' : dayPartMeridiem
    const hour = adjustHour(rawHour, meridiem)
    if (hour <= 23 && minute <= 59) time = { hour, minute }
  }

  // --- 4. Relative day words --------------------------------------------
  const dayWord = find(/\b(pasado\s+manana|day\s+after\s+tomorrow|manana|tomorrow|hoy|today)\b/)
  if (dayWord && dayOffset === null) {
    const w = dayWord[1]
    dayOffset = /^(pasado|day)/.test(w) ? 2 : /^(manana|tomorrow)/.test(w) ? 1 : 0
  }

  // --- 5. Weekday -------------------------------------------------------
  let weekday: number | null = null
  const wd = find(
    /\b(?:(?:el|este|proximo|siguiente|next|on|this)\s+)*(lunes|martes|miercoles|jueves|viernes|sabado|domingo|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/,
  )
  if (wd) {
    const i = WEEKDAYS_ES.indexOf(wd[1])
    weekday = i >= 0 ? i : WEEKDAYS_EN.indexOf(wd[1])
  }

  // --- 6. Explicit date -------------------------------------------------
  let explicit: { year: number | null; month: number; day: number } | null = null
  const named = find(
    /\b(?:el\s+)?(\d{1,2})\s+(?:de\s+)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+(?:de\s+|del\s+)?(\d{4}))?\b/,
  )
  if (named) {
    const name = named[2] === 'setiembre' ? 'septiembre' : named[2]
    const mi = MONTHS_ES.indexOf(name)
    const month = (mi >= 0 ? mi : MONTHS_EN.indexOf(name)) + 1
    explicit = { year: named[3] ? parseInt(named[3], 10) : null, month, day: parseInt(named[1], 10) }
  } else {
    const numeric = find(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/)
    if (numeric) {
      const y = numeric[3] ? parseInt(numeric[3], 10) : null
      explicit = {
        year: y === null ? null : y < 100 ? 2000 + y : y,
        month: parseInt(numeric[2], 10),
        day: parseInt(numeric[1], 10),
      }
    }
  }

  const anything =
    exactDelta !== null || dayOffset !== null || dayPartHour !== null || time !== null || weekday !== null || explicit !== null
  if (!anything) return null

  // --- Compose ----------------------------------------------------------
  let dueAt: Date
  let hasTime = false

  if (exactDelta !== null) {
    dueAt = new Date(now.getTime() + exactDelta)
    hasTime = true
  } else {
    const today = localParts(now, timeZone)
    let { year, month, day } = today
    let dayGiven = false

    if (explicit) {
      if (explicit.month < 1 || explicit.month > 12 || explicit.day < 1 || explicit.day > 31) return null
      month = explicit.month
      day = explicit.day
      year = explicit.year ?? today.year
      if (explicit.year === null && Date.UTC(year, month - 1, day) < Date.UTC(today.year, today.month - 1, today.day)) {
        year += 1
      }
      dayGiven = true
    } else if (weekday !== null) {
      const diff = (weekday - today.weekday + 7) % 7 || 7
      ;({ year, month, day } = shiftDays(today, diff))
      dayGiven = true
    } else if (dayOffset !== null) {
      ;({ year, month, day } = shiftDays(today, dayOffset))
      dayGiven = true
    }

    let hour = defaultHour
    let minute = 0
    if (time) {
      hour = time.hour
      minute = time.minute
      hasTime = true
    } else if (dayPartHour !== null) {
      hour = dayPartHour
      hasTime = true
    }

    dueAt = zonedToUtc(year, month, day, hour, minute, timeZone)
    if (!dayGiven && dueAt.getTime() <= now.getTime()) {
      const next = shiftDays({ year, month, day }, 1)
      dueAt = zonedToUtc(next.year, next.month, next.day, hour, minute, timeZone)
    }
  }

  return {
    dueAt,
    title: buildTitle(text, spans, opts.fallbackTitle ?? 'Seguimiento'),
    personHint: personHint(text),
    hasTime,
  }
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

/** Lower-case, accent-less copy with the SAME length as the input. */
function fold(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const base = ch.normalize('NFD')[0] ?? ch
    const lower = base.toLowerCase()
    out += lower.length === 1 ? lower : base
  }
  return out
}

function adjustHour(hour: number, meridiem: Meridiem): number {
  if (meridiem === 'pm') return hour < 12 ? hour + 12 : hour
  if (meridiem === 'am') return hour === 12 ? 0 : hour
  // "a las 3" on a sales floor is 15:00, not 03:00.
  return hour >= 1 && hour <= 6 ? hour + 12 : hour
}

interface LocalParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  weekday: number
}

const WD_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function localParts(date: Date, timeZone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
  })
  const parts: Record<string, string> = {}
  for (const p of fmt.formatToParts(date)) if (p.type !== 'literal') parts[p.type] = p.value
  return {
    year: parseInt(parts.year, 10),
    month: parseInt(parts.month, 10),
    day: parseInt(parts.day, 10),
    hour: parseInt(parts.hour, 10) % 24,
    minute: parseInt(parts.minute, 10),
    weekday: Math.max(0, WD_SHORT.indexOf(parts.weekday)),
  }
}

function shiftDays(
  from: { year: number; month: number; day: number },
  days: number,
): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(from.year, from.month - 1, from.day + days))
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

/** Wall-clock in `timeZone` → instant. Two passes so DST edges resolve. */
function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute)
  let guess = new Date(naive - zoneOffsetMinutes(new Date(naive), timeZone) * 60_000)
  guess = new Date(naive - zoneOffsetMinutes(guess, timeZone) * 60_000)
  return guess
}

const COMMAND_PREFIX =
  /^\s*(?:recuerdame|recordarme|recordar|recordatorio|acuerdate|avisame|avisarme|seguimiento|follow[\s-]?up|remind\s+me(?:\s+to)?|reminder)\s*[:,\-–]?\s*/
const LEADING_CONNECTOR = /^\s*(?:que|de|para|a|to|y|and)\s+/
const TRAILING_CONNECTOR = /\s+(?:que|de|para|a|to|y|and|el|la|en|on|at)\s*$/

function buildTitle(text: string, spans: Array<[number, number]>, fallback: string): string {
  let orig = text
  let nrm = fold(text)
  for (const [start, end] of [...spans].sort((a, b) => b[0] - a[0])) {
    orig = orig.slice(0, start) + ' ' + orig.slice(end)
    nrm = nrm.slice(0, start) + ' ' + nrm.slice(end)
  }
  const prefix = COMMAND_PREFIX.exec(nrm)
  if (prefix) {
    orig = orig.slice(prefix[0].length)
    nrm = nrm.slice(prefix[0].length)
  }
  for (let i = 0; i < 3; i++) {
    const lead = LEADING_CONNECTOR.exec(nrm)
    if (lead) {
      orig = orig.slice(lead[0].length)
      nrm = nrm.slice(lead[0].length)
    }
    const tail = TRAILING_CONNECTOR.exec(nrm)
    if (tail) {
      orig = orig.slice(0, tail.index)
      nrm = nrm.slice(0, tail.index)
    }
  }
  const title = orig
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.;:\-–]+|[\s,.;:\-–]+$/g, '')
    .trim()
  if (!title) return fallback
  return title.charAt(0).toUpperCase() + title.slice(1)
}

function personHint(text: string): string | null {
  const m = /(?:^|\s)(?:a|con|to|with)\s+([A-ZÁÉÍÓÚÑ][\p{L}]+(?:\s+[A-ZÁÉÍÓÚÑ][\p{L}]+)?)/u.exec(text)
  if (!m) return null
  const hint = m[1].trim()
  const folded = fold(hint)
  if (WEEKDAYS_ES.includes(folded) || WEEKDAYS_EN.includes(folded) || MONTHS_ES.includes(folded) || MONTHS_EN.includes(folded)) {
    return null
  }
  return hint
}
