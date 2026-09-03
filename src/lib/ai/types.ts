// ============================================================
// Shared types for the AI reply assistant (bring-your-own-key).
//
// One small provider-agnostic surface so the inbox draft route and the
// inbound auto-reply bot both talk to `generateReply` without caring
// whether the account is on OpenAI or Anthropic.
// ============================================================

export type AiProvider = 'openai' | 'anthropic'

/**
 * Account AI setup, decrypted and ready to use. Produced by
 * `loadAiConfig` — `apiKey` is the plaintext BYO provider key
 * (stored AES-256-GCM-encrypted at rest).
 */
export interface AiConfig {
  provider: AiProvider
  model: string
  apiKey: string
  systemPrompt: string | null
  isActive: boolean
  autoReplyEnabled: boolean
  autoReplyMaxPerConversation: number
  /** Where auto-reply hands a conversation off when the model bails: an
   *  agent's `auth.users.id`, or null to leave it unassigned (drop into
   *  the shared queue). */
  handoffAgentId: string | null
  /** Optional OpenAI-compatible key for embeddings. When set, the
   *  knowledge base is embedded and semantic retrieval turns on; when
   *  null, retrieval falls back to lexical full-text search. */
  embeddingsApiKey: string | null
  /** No-prompt configuration (migration 042); compiled by lib/ai/persona. */
  persona: AiPersona
}

/**
 * Everything an admin sets about how the assistant talks — without
 * writing a prompt. All optional; `compilePersona` fills sensible
 * defaults for the business's locale.
 */
export interface AiPersona {
  name?: string
  role?: string
  /** BCP-47-ish, e.g. 'es'. */
  language?: string
  /** Free text, e.g. 'Perú'. Drives vocabulary and examples. */
  region?: string
  formality?: 'tu' | 'usted'
  /** e.g. 'cercano', 'profesional', 'comercial', 'técnico'. */
  tone?: string
  replyLength?: 'short' | 'medium' | 'long'
  emojis?: boolean
  style?: string
  /** The one thing the assistant is for, e.g. "Convertir consultas en oportunidades comerciales". */
  objective?: string
  specialInstructions?: string
}

/** One tool the model may call during a structured turn. */
export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema of the input object. */
  schema: Record<string, unknown>
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResult {
  callId: string
  name: string
  output: unknown
}

/** One completed exchange: what the model asked for and what it got back. */
export interface ToolRound {
  calls: ToolCall[]
  results: ToolResult[]
}

/** What a provider adapter returns from ONE round of a tool-enabled call. */
export interface ProviderToolResult {
  /** Tool calls the model wants executed this round (may be empty). */
  calls: ToolCall[]
  /** Any free text the model produced alongside (usually empty in tool mode). */
  text: string
  usage: AiUsage | null
}

/** A single conversation turn in the shape both providers accept. */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Token counts for one provider call, normalized across OpenAI
 * (`prompt`/`completion`) and Anthropic (`input`/`output`). Null when
 * the provider didn't return usage. Logged to `ai_usage_log`.
 */
export interface AiUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/** Raw text + usage a provider adapter returns before handoff parsing. */
export interface ProviderResult {
  text: string
  usage: AiUsage | null
}

/** Outcome of a generation call. */
export interface GenerateResult {
  /** The reply text, with any handoff sentinel stripped. */
  text: string
  /** True when the model asked to hand off to a human (auto-reply mode). */
  handoff: boolean
  /** Provider token usage for this call, or null when unavailable. */
  usage: AiUsage | null
}

/**
 * Typed error for every AI failure mode. `status` maps cleanly to an
 * HTTP response in the draft route; `code` lets the UI/tests branch
 * (invalid_key vs rate_limited vs timeout, etc.).
 */
export class AiError extends Error {
  readonly code: string
  readonly status: number
  constructor(message: string, opts: { code?: string; status?: number } = {}) {
    super(message)
    this.name = 'AiError'
    this.code = opts.code ?? 'ai_error'
    this.status = opts.status ?? 502
  }
}
