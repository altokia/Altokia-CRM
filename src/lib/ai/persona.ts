/**
 * Turn the no-prompt configuration into instructions.
 *
 * An admin picks a name, a role, tú/usted, a tone, a length, an
 * objective — and never writes a prompt. This module is the only place
 * those choices become model instructions, so the wording is
 * consistent across accounts and the settings form stays a form.
 *
 * Defaults lean towards the first market (Spanish, Peru, "tú", short
 * WhatsApp replies) but every default is overridable per account.
 */

import type { AiPersona } from './types'

const LANGUAGE_NAMES: Record<string, string> = {
  es: 'Spanish',
  en: 'English',
  pt: 'Portuguese',
}

export function compilePersona(persona: AiPersona, opts: { defaultLanguage?: string } = {}): string {
  const language = persona.language ?? opts.defaultLanguage ?? 'es'
  const languageName = LANGUAGE_NAMES[language] ?? language
  const formality = persona.formality ?? 'tu'
  const length = persona.replyLength ?? 'short'
  const emojis = persona.emojis ?? false
  const isPeru = /per[uú]/i.test(persona.region ?? '')

  const lines: string[] = []

  lines.push(
    persona.name
      ? `Your name is ${persona.name}.${persona.role ? ` You are the ${persona.role} of the business.` : ''}`
      : persona.role
        ? `You are the ${persona.role} of the business.`
        : 'You are the business\'s assistant on WhatsApp.',
  )

  lines.push(
    `Write in ${languageName}${persona.region ? ` as spoken in ${persona.region}` : ''}. ` +
      (language === 'es'
        ? formality === 'usted'
          ? 'Address the customer as "usted".'
          : 'Address the customer as "tú" — never "vos", never "usted".'
        : ''),
  )

  const toneBits = [persona.tone, persona.style].filter(Boolean)
  lines.push(
    toneBits.length
      ? `Tone: ${toneBits.join(', ')}.`
      : 'Tone: warm, clear and professional — like a helpful person from the business, not a bot.',
  )

  lines.push(
    length === 'short'
      ? 'Keep replies short: one to three sentences, as people write on WhatsApp. Ask one question at a time.'
      : length === 'long'
        ? 'Replies may be detailed when the question needs it, but stay conversational and split ideas into short paragraphs.'
        : 'Keep replies concise: a few sentences, conversational, one question at a time.',
  )

  lines.push(emojis ? 'A light touch of emojis is fine when it fits.' : 'Do not use emojis.')

  if (isPeru) {
    lines.push(
      'Use casual, elegant Peruvian Spanish: natural expressions may include "qué bacán", "chévere", "de una", "ya", "buenazo", "te cuento", "te confirmo", "perfecto", "listo", "genial" and "tranqui" when they genuinely fit the customer\'s tone. ' +
        'Useful natural replies include "Sí, claro", "Déjame confirmarlo", "Te ayudo con eso", "Buenazo, lo reviso", "De una, ¿para qué distrito sería?" and "Ya, te cuento". ' +
        'Do not force slang, overuse diminutives, or use caricatured regionalisms. Prefer clear everyday words such as precio, talla, color, stock, delivery, recojo, distrito, provincia, Yape, Plin, transferencia, contraentrega and agencia when relevant. ' +
        'Keep the tone close and helpful, never overly formal, robotic or salesy.',
    )
  }

  if (persona.objective) {
    lines.push(`Your main objective: ${persona.objective}.`)
  } else {
    lines.push(
      'Your main objective: help the customer and turn genuine interest into a next step (a call, a visit, an appointment, a quote) with a person from the team.',
    )
  }

  if (persona.specialInstructions) {
    lines.push(`Special instructions from the business:\n${persona.specialInstructions}`)
  }

  return lines.join('\n')
}
