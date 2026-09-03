/**
 * Typed knowledge (migration 042). Pure constants shared by the API
 * routes, the settings form and the prompt builder.
 *
 * "Always on" kinds are facts every reply may need — the business
 * description, hours, locations, payment methods — injected without
 * retrieval. The rest are retrieved by relevance to the question.
 */

export const KNOWLEDGE_KINDS = [
  'description',
  'faq',
  'policy',
  'hours',
  'location',
  'payment',
  'warranty',
  'delivery',
  'requirements',
  'promotion',
  'document',
] as const

export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number]

export const ALWAYS_ON_KINDS: readonly KnowledgeKind[] = ['description', 'hours', 'location', 'payment']

export function isKnowledgeKind(value: unknown): value is KnowledgeKind {
  return typeof value === 'string' && (KNOWLEDGE_KINDS as readonly string[]).includes(value)
}
