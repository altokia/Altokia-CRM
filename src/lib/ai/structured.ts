/**
 * The structured reply — what the assistant returns for every inbound
 * message once the natural-language mode is on.
 *
 * Instead of a bare text (plus a magic `[[HANDOFF]]` substring), the
 * model ends its turn by calling a `respond` tool whose input is this
 * shape. The reply text is one field among the things the business
 * actually needs: what the customer wants, about which item, how
 * urgent, what to do next, whether a person is needed, and how to
 * label the lead. Nothing here is specific to an industry — an academy
 * and a real-estate agency fill the same fields with different words.
 *
 * Both provider adapters translate this one JSON Schema into their
 * tool format; `parseStructuredReply` is the single place the raw tool
 * input is validated and normalised.
 */

import type { TaskActionType, TaskPriority } from '@/types'

export const STRUCTURED_ACTION_TYPES = [
  'AI_CONTINUE',
  'HUMAN_CHAT',
  'CALL',
  'FOLLOW_UP',
  'APPOINTMENT',
  'QUOTE',
  'REVIEW_REQUIRED',
] as const

export interface StructuredReply {
  /** Message to send to the customer. Empty when there is nothing safe to say. */
  reply: string
  /** Short machine-friendly intent, e.g. price_inquiry, availability, request_call, complaint, other. */
  intent: string
  intentLevel: 'low' | 'medium' | 'high'
  /** The product/service as the customer referred to it, if any. */
  itemName: string | null
  /** Catalog id when the tools matched it; never guessed. */
  itemId: string | null
  need: string | null
  priority: TaskPriority
  preferences: Record<string, unknown>
  collectedInfo: Record<string, unknown>
  nextAction: string | null
  actionType: TaskActionType
  needsHuman: boolean
  /** One of the account's lead_labels.key values. */
  leadLabel: string | null
  preferredContactTime: string | null
  /** 2–3 sentences a teammate can read in five seconds. */
  summary: string
}

export interface LeadLabelOption {
  key: string
  name: string
  description: string | null
}

/**
 * JSON Schema for the `respond` tool. `labelKeys` narrows lead_label to
 * the account's own keys so the model cannot invent one.
 */
export function respondToolSchema(labelKeys: string[]): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      reply: { type: 'string', description: 'The exact message to send to the customer, in their language. Empty string if a human must answer instead.' },
      intent: { type: 'string', description: 'Short snake_case intent: price_inquiry, availability, how_to_start, request_call, appointment, quote, complaint, follow_up_on_previous, general_question, other.' },
      intent_level: { type: 'string', enum: ['low', 'medium', 'high'], description: 'How close this person is to buying/booking.' },
      item_name: { type: ['string', 'null'], description: 'Product or service the customer is asking about, in their own words.' },
      item_id: { type: ['string', 'null'], description: 'Catalog id returned by search_items/get_item that matches item_name. null if no tool result matched.' },
      need: { type: ['string', 'null'], description: 'What they actually need, one sentence.' },
      priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
      preferences: { type: 'object', additionalProperties: true, description: 'Stated preferences (schedule, modality, budget, location...).' },
      collected_info: { type: 'object', additionalProperties: true, description: 'Facts the customer gave: name, who it is for, quantity, dates...' },
      next_action: { type: ['string', 'null'], description: 'What the team should do next, one sentence.' },
      action_type: { type: 'string', enum: [...STRUCTURED_ACTION_TYPES] },
      needs_human: { type: 'boolean', description: 'true when a person must take over (explicit request, complaint, or information you do not have).' },
      lead_label: { type: ['string', 'null'], enum: [...labelKeys, null], description: 'Commercial reading of this contact using the business labels.' },
      preferred_contact_time: { type: ['string', 'null'], description: 'When they want to be contacted, as they said it (e.g. "después de las 3pm").' },
      summary: { type: 'string', description: 'Two or three sentences for a teammate: interest, what they asked, where they are, what to do next.' },
    },
    required: ['reply', 'intent', 'intent_level', 'priority', 'action_type', 'needs_human', 'summary'],
  }
}

export const RESPOND_TOOL_NAME = 'respond'

export const RESPOND_TOOL_DESCRIPTION =
  'Finish your turn. Call this exactly once with the message for the customer and your structured reading of the conversation. Every turn must end with this call.'

const PRIORITIES = new Set(['low', 'normal', 'high', 'urgent'])
const LEVELS = new Set(['low', 'medium', 'high'])

/**
 * Validate and normalise a raw `respond` input. Lenient on optional
 * fields, strict on the enums the rest of the system branches on.
 * Unknown label keys are dropped (never stored), so a hallucinated
 * label cannot leak into the business's taxonomy.
 */
export function parseStructuredReply(
  raw: unknown,
  opts: { labelKeys: string[] },
): StructuredReply {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() ? v.trim() : null
  const obj = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

  const actionType = typeof o.action_type === 'string' &&
    (STRUCTURED_ACTION_TYPES as readonly string[]).includes(o.action_type)
    ? (o.action_type as TaskActionType)
    : 'AI_CONTINUE'
  const needsHuman = o.needs_human === true || (actionType !== 'AI_CONTINUE' && o.needs_human !== false)
  const label = str(o.lead_label)

  return {
    reply: typeof o.reply === 'string' ? o.reply.trim() : '',
    intent: str(o.intent) ?? 'other',
    intentLevel: LEVELS.has(o.intent_level as string) ? (o.intent_level as StructuredReply['intentLevel']) : 'low',
    itemName: str(o.item_name),
    itemId: str(o.item_id),
    need: str(o.need),
    priority: PRIORITIES.has(o.priority as string) ? (o.priority as TaskPriority) : 'normal',
    preferences: obj(o.preferences),
    collectedInfo: obj(o.collected_info),
    nextAction: str(o.next_action),
    actionType,
    needsHuman,
    leadLabel: label && opts.labelKeys.includes(label) ? label : null,
    preferredContactTime: str(o.preferred_contact_time),
    summary: str(o.summary) ?? '',
  }
}
