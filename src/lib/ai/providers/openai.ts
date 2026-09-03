import {
  AiError,
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

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'

interface OpenAiResponse {
  choices?: { message?: { content?: string } }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

/**
 * Call OpenAI's Chat Completions endpoint with the caller's own key.
 * Returns the raw assistant text + token usage (handoff parsing happens
 * in `generateReply`).
 */
export async function generateOpenAi(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args

  let res: Response
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...mergeConsecutive(messages),
        ],
        max_completion_tokens: MAX_OUTPUT_TOKENS,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('OpenAI', res)
  }

  const data = (await res.json().catch(() => null)) as OpenAiResponse | null
  const text = data?.choices?.[0]?.message?.content
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new AiError('OpenAI returned an empty response.', {
      code: 'empty_response',
    })
  }
  const usage = normalizeUsage({
    prompt: data?.usage?.prompt_tokens,
    completion: data?.usage?.completion_tokens,
    total: data?.usage?.total_tokens,
  })
  return { text, usage }
}

// ============================================================
// Tool mode — one round of a tool-enabled call.
// ============================================================

interface OpenAiToolCallWire {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface OpenAiToolResponse {
  choices?: {
    message?: { content?: string | null; tool_calls?: OpenAiToolCallWire[] }
  }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

/**
 * Serialize completed rounds into Chat Completions' shape: the
 * assistant message carrying `tool_calls`, followed by one `tool`
 * message per result. `arguments` is a JSON *string* on the wire.
 */
function serializeRounds(rounds: ToolRound[]) {
  const out: Record<string, unknown>[] = []
  for (const round of rounds) {
    out.push({
      role: 'assistant',
      content: null,
      tool_calls: round.calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.input) },
      })),
    })
    for (const r of round.results) {
      out.push({ role: 'tool', tool_call_id: r.callId, content: JSON.stringify(r.output) })
    }
  }
  return out
}

/**
 * One round: the model either calls tools or (when forced) the final
 * `respond` tool. `tool_choice: 'required'` guarantees a tool call every
 * round, which is what lets the caller drive the loop without parsing
 * free text.
 */
export async function generateOpenAiTools(
  args: ProviderArgs & { tools: ToolDefinition[]; rounds: ToolRound[] },
): Promise<ProviderToolResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, tools, rounds } = args

  let res: Response
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...mergeConsecutive(messages),
          ...serializeRounds(rounds),
        ],
        tools: tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.schema },
        })),
        tool_choice: 'required',
        max_completion_tokens: MAX_OUTPUT_TOKENS,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('OpenAI', res)
  }

  const data = (await res.json().catch(() => null)) as OpenAiToolResponse | null
  const message = data?.choices?.[0]?.message
  const calls: ToolCall[] = (message?.tool_calls ?? []).flatMap((c) => {
    let input: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(c.function.arguments || '{}')
      if (parsed && typeof parsed === 'object') input = parsed as Record<string, unknown>
    } catch {
      // Malformed arguments: surface an empty input; the tool answers
      // with a readable error the model can correct on the next round.
    }
    return [{ id: c.id, name: c.function.name, input }]
  })

  if (calls.length === 0 && !(message?.content ?? '').trim()) {
    throw new AiError('OpenAI returned neither a tool call nor text.', { code: 'empty_response' })
  }

  return {
    calls,
    text: (message?.content ?? '').trim(),
    usage: normalizeUsage({
      prompt: data?.usage?.prompt_tokens,
      completion: data?.usage?.completion_tokens,
      total: data?.usage?.total_tokens,
    }),
  }
}
