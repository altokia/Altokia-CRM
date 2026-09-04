/**
 * Per-business wording, shared by the settings form, the `useTerm`
 * hook and the API route that persists it.
 *
 * A CRM concept has one stable key in code and in the database
 * (`won`, `lead`, `catalog_item`…); what the business calls it is a
 * display override stored in `accounts.terminology` (migration 040).
 * Nothing here touches data — an academy that renames "won" to
 * "Matriculado" and a shop that renames it to "Vendido" keep the same
 * rows, the same queries and the same AI prompts.
 *
 * The default word always comes from next-intl, so an account with no
 * overrides is fully translated and a business that renames only one
 * concept doesn't lose the translation of the other eight.
 */

export const TERMINOLOGY_KEYS = [
  'won',
  'lost',
  'lead',
  'leads',
  'deal',
  'advisor',
  'advisors',
  'pipeline',
  'catalog_item',
] as const

export type TerminologyKey = (typeof TERMINOLOGY_KEYS)[number]

/**
 * Longest override we accept. These words sit inside stat tiles, table
 * headers and pipeline columns, so a sentence pasted in here would
 * break the layout everywhere at once rather than in one screen.
 */
export const TERM_MAX_LENGTH = 40

/**
 * next-intl segment for each stored key. The stored key is snake_case
 * (`catalog_item`) while message paths are camelCase (`catalogItem`);
 * mixing the two silently yields either an untranslated label or an
 * override that never applies, so the mapping lives here once instead
 * of being re-derived at each call site.
 */
export const TERM_MESSAGE_KEYS: Record<TerminologyKey, string> = {
  won: 'won',
  lost: 'lost',
  lead: 'lead',
  leads: 'leads',
  deal: 'deal',
  advisor: 'advisor',
  advisors: 'advisors',
  pipeline: 'pipeline',
  catalog_item: 'catalogItem',
}

export function isTerminologyKey(value: unknown): value is TerminologyKey {
  return (
    typeof value === 'string' &&
    (TERMINOLOGY_KEYS as readonly string[]).includes(value)
  )
}

/**
 * Coerce whatever is stored (or submitted) into the overrides map the
 * UI can trust: known keys only, trimmed, no empty values.
 *
 * An empty string means "no override" rather than "an empty label" —
 * that's how clearing a field in the settings form removes a word. The
 * column is free-form JSONB, so this also runs on the way out of the
 * database: a hand-edited row can't inject a key the UI doesn't know.
 */
export function normalizeTerminology(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const input = raw as Record<string, unknown>
  const out: Record<string, string> = {}
  // Iterating the contract rather than the input's own keys is what
  // drops unknown ones, and it keeps the stored object's key order
  // stable so callers can compare two versions by serialising them.
  for (const key of TERMINOLOGY_KEYS) {
    const value = input[key]
    if (typeof value !== 'string') continue
    const trimmed = value.trim().slice(0, TERM_MAX_LENGTH)
    if (!trimmed) continue
    out[key] = trimmed
  }
  return out
}
