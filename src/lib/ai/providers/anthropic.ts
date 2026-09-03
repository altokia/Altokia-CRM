import {
  AiError,
  type ChatMessage,
  type ProviderResult,
  type ProviderToolResult,
  type ToolCall,
  type ToolDefinition,
  type ToolRound,
} from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

interface AnthropicResponse {
  content?: { type?: string; text?: string }[]
  usage?: { input_tokens?: number; output_tokens?: number }
}

/**
 * Anthropic's Messages API requires strictly alternating roles that
 * begin with `user`. Merge consecutive turns, then drop any leading
 * assistant turns (an agent greeting before the customer said anything)
 * so the transcript always starts on the customer. Guarantees a valid,
 * non-empty payload.
 */
function normalizeForAnthropic(messages: ChatMessage[]): ChatMessage[] {
  const merged = mergeConsecutive(messages)
  while (merged.length > 0 && merged[0].role === 'assistant') {
    merged.shift()
  }
  if (merged.length === 0) {
    return [{ role: 'user', content: '(The customer has not sent a message yet.)' }]
  }
  return merged
}

/**
 * Call Anthropic's Messages endpoint with the caller's own key.
 * Returns the raw assistant text + token usage (handoff parsing happens
 * in `generateReply`).
 */
export async function generateAnthropic(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args

  let res: Response
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        system: systemPrompt,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: normalizeForAnthropic(messages),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('Anthropic', res)
  }

  const data = (await res.json().catch(() => null)) as AnthropicResponse | null
  const text = data?.content
    ?.filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim()
  if (!text) {
    throw new AiError('Anthropic returned an empty response.', {
      code: 'empty_response',
    })
  }
  // Anthropic reports input/output but no total — normalizeUsage sums.
  const usage = normalizeUsage({
    prompt: data?.usage?.input_tokens,
    completion: data?.usage?.output_tokens,
  })
  return { text, usage }
}

// ============================================================
// Tool mode — one round of a tool-enabled call.
// ============================================================

interface AnthropicToolResponse {
  content?: Array<
    | { type: 'text'; text?: string }
    | { type: 'tool_use'; id: string; name: string; input?: unknown }
  >
  usage?: { input_tokens?: number; output_tokens?: number }
}

/**
 * Serialize completed rounds into the Messages API shape: an assistant
 * turn of `tool_use` blocks, then a user turn of `tool_result` blocks.
 * Roles keep alternating, which the API insists on.
 */
function serializeRounds(rounds: ToolRound[]) {
  const out: Record<string, unknown>[] = []
  for (const round of rounds) {
    out.push({
      role: 'assistant',
      content: round.calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })),
    })
    out.push({
      role: 'user',
      content: round.results.map((r) => ({
        type: 'tool_result',
        tool_use_id: r.callId,
        content: JSON.stringify(r.output),
      })),
    })
  }
  return out
}

/**
 * One round with tools. `tool_choice: any` forces a tool call every
 * round, so the loop never has to interpret free text.
 */
export async function generateAnthropicTools(
  args: ProviderArgs & { tools: ToolDefinition[]; rounds: ToolRound[] },
): Promise<ProviderToolResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, tools, rounds } = args

  let res: Response
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        system: systemPrompt,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [...normalizeForAnthropic(messages), ...serializeRounds(rounds)],
        tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema })),
        tool_choice: { type: 'any' },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('Anthropic', res)
  }

  const data = (await res.json().catch(() => null)) as AnthropicToolResponse | null
  const blocks = data?.content ?? []
  const calls: ToolCall[] = blocks.flatMap((b) =>
    b.type === 'tool_use'
      ? [{ id: b.id, name: b.name, input: (b.input && typeof b.input === 'object' ? b.input : {}) as Record<string, unknown> }]
      : [],
  )
  const text = blocks
    .flatMap((b) => (b.type === 'text' && typeof b.text === 'string' ? [b.text] : []))
    .join('')
    .trim()

  if (calls.length === 0 && !text) {
    throw new AiError('Anthropic returned neither a tool call nor text.', { code: 'empty_response' })
  }

  return {
    calls,
    text,
    usage: normalizeUsage({
      prompt: data?.usage?.input_tokens,
      completion: data?.usage?.output_tokens,
    }),
  }
}
