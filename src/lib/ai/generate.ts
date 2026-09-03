import {
  AiError,
  type AiConfig,
  type AiUsage,
  type ChatMessage,
  type GenerateResult,
  type ToolCall,
  type ToolDefinition,
  type ToolRound,
} from './types'
import { HANDOFF_SENTINEL, aiRequestTimeoutMs } from './defaults'
import { generateOpenAi, generateOpenAiTools } from './providers/openai'
import { generateAnthropic, generateAnthropicTools } from './providers/anthropic'
import {
  RESPOND_TOOL_DESCRIPTION,
  RESPOND_TOOL_NAME,
  parseStructuredReply,
  respondToolSchema,
  type StructuredReply,
} from './structured'

export interface GenerateArgs {
  config: AiConfig
  /** Fully-built system prompt (see `buildSystemPrompt`). */
  systemPrompt: string
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[]
}

/**
 * Generate the next reply from the account's configured provider.
 * Dispatches to the right adapter, then parses the handoff sentinel out
 * of the raw text. Throws `AiError` on any provider/network failure.
 */
export async function generateReply(args: GenerateArgs): Promise<GenerateResult> {
  const { config, systemPrompt, messages } = args
  const timeoutMs = aiRequestTimeoutMs()
  const providerArgs = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    messages,
    timeoutMs,
  }

  let result: { text: string; usage: AiUsage | null }
  switch (config.provider) {
    case 'openai':
      result = await generateOpenAi(providerArgs)
      break
    case 'anthropic':
      result = await generateAnthropic(providerArgs)
      break
    default:
      throw new AiError(`Unsupported AI provider: ${config.provider}`, {
        code: 'unsupported_provider',
        status: 400,
      })
  }

  return parseGeneration(result.text, result.usage)
}

/**
 * Split the raw model output into `{ text, handoff, usage }`. The
 * sentinel can appear alone or trailing a partial reply; either way we
 * treat the turn as a handoff and strip the marker from any remaining
 * text. `usage` is passed straight through (null when the provider
 * didn't report it).
 */
export function parseGeneration(
  raw: string,
  usage: AiUsage | null = null,
): GenerateResult {
  const handoff = raw.includes(HANDOFF_SENTINEL)
  const text = raw.split(HANDOFF_SENTINEL).join('').trim()
  return { text, handoff, usage }
}

// ============================================================
// Structured mode — tools + a final `respond` call.
// ============================================================

export interface GenerateStructuredArgs {
  config: AiConfig
  systemPrompt: string
  messages: ChatMessage[]
  /** Look-up tools the model may call before answering. */
  tools: ToolDefinition[]
  /** Runs one tool call; must never throw (return an error object instead). */
  runTool: (call: ToolCall) => Promise<unknown>
  /** The account's lead_labels keys, so the model cannot invent one. */
  labelKeys: string[]
  /** Look-up rounds allowed before the model is forced to respond. */
  maxToolRounds?: number
}

export interface GenerateStructuredResult {
  structured: StructuredReply
  usage: AiUsage | null
  /** How many look-up rounds happened (0 = answered directly). */
  toolRounds: number
}

/**
 * Drive a tool loop until the model calls `respond`.
 *
 * Every round the model must call a tool (both providers are asked for
 * that). Look-up calls are executed and fed back; the loop ends on the
 * `respond` call, whose input is validated into a StructuredReply. On
 * the last permitted round only `respond` is offered, so the loop is
 * bounded by construction — no runaway searches inside the webhook's
 * time budget.
 *
 * Token usage is summed across rounds so one usage-log row reflects
 * the whole turn.
 */
export async function generateStructured(
  args: GenerateStructuredArgs,
): Promise<GenerateStructuredResult> {
  const { config, systemPrompt, messages, tools, runTool, labelKeys } = args
  const maxToolRounds = args.maxToolRounds ?? 2
  const timeoutMs = aiRequestTimeoutMs()

  const respondTool: ToolDefinition = {
    name: RESPOND_TOOL_NAME,
    description: RESPOND_TOOL_DESCRIPTION,
    schema: respondToolSchema(labelKeys),
  }

  const rounds: ToolRound[] = []
  let usage: AiUsage | null = null
  const addUsage = (u: AiUsage | null) => {
    if (!u) return
    usage = usage
      ? {
          promptTokens: usage.promptTokens + u.promptTokens,
          completionTokens: usage.completionTokens + u.completionTokens,
          totalTokens: usage.totalTokens + u.totalTokens,
        }
      : u
  }

  for (let round = 0; ; round++) {
    const lastRound = round >= maxToolRounds
    const offered = lastRound ? [respondTool] : [...tools, respondTool]
    const providerArgs = {
      apiKey: config.apiKey,
      model: config.model,
      systemPrompt,
      messages,
      timeoutMs,
      tools: offered,
      rounds,
    }

    const res =
      config.provider === 'openai'
        ? await generateOpenAiTools(providerArgs)
        : config.provider === 'anthropic'
          ? await generateAnthropicTools(providerArgs)
          : (() => {
              throw new AiError(`Unsupported AI provider: ${config.provider}`, {
                code: 'unsupported_provider',
                status: 400,
              })
            })()
    addUsage(res.usage)

    const respond = res.calls.find((c) => c.name === RESPOND_TOOL_NAME)
    if (respond) {
      return {
        structured: parseStructuredReply(respond.input, { labelKeys }),
        usage,
        toolRounds: rounds.length,
      }
    }

    const lookups = res.calls.filter((c) => c.name !== RESPOND_TOOL_NAME)
    if (lookups.length === 0) {
      // The model answered in prose despite being asked for a tool call.
      // Keep the text rather than dropping the customer's message; the
      // rest of the structure falls back to safe defaults.
      return {
        structured: parseStructuredReply({ reply: res.text, needs_human: false }, { labelKeys }),
        usage,
        toolRounds: rounds.length,
      }
    }

    const results = await Promise.all(
      lookups.map(async (call) => ({
        callId: call.id,
        name: call.name,
        output: await runTool(call),
      })),
    )
    rounds.push({ calls: lookups, results })
  }
}
