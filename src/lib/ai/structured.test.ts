import { describe, expect, it, vi, beforeEach } from 'vitest'
import { parseStructuredReply, respondToolSchema } from './structured'

const h = vi.hoisted(() => ({
  openai: vi.fn(),
  anthropic: vi.fn(),
}))
vi.mock('./providers/openai', () => ({
  generateOpenAi: vi.fn(),
  generateOpenAiTools: h.openai,
}))
vi.mock('./providers/anthropic', () => ({
  generateAnthropic: vi.fn(),
  generateAnthropicTools: h.anthropic,
}))

import { generateStructured } from './generate'
import type { AiConfig } from './types'

const config: AiConfig = {
  provider: 'openai',
  model: 'gpt-test',
  apiKey: 'k',
  systemPrompt: null,
  isActive: true,
  autoReplyEnabled: true,
  autoReplyMaxPerConversation: 3,
  handoffAgentId: null,
  embeddingsApiKey: null,
  persona: {},
}

describe('parseStructuredReply', () => {
  it('normalises a full respond payload', () => {
    const r = parseStructuredReply(
      {
        reply: ' Hola ',
        intent: 'price_inquiry',
        intent_level: 'high',
        item_name: 'curso de inglés',
        item_id: 'abc',
        need: 'clases para su hijo',
        priority: 'high',
        preferences: { modalidad: 'virtual' },
        collected_info: { para: 'hijo de 10 años' },
        next_action: 'llamar',
        action_type: 'CALL',
        needs_human: true,
        lead_label: 'interested',
        preferred_contact_time: 'después de las 3',
        summary: 'Quiere precio y vacantes.',
      },
      { labelKeys: ['possible_lead', 'interested'] },
    )
    expect(r.reply).toBe('Hola')
    expect(r.actionType).toBe('CALL')
    expect(r.needsHuman).toBe(true)
    expect(r.leadLabel).toBe('interested')
    expect(r.preferences).toEqual({ modalidad: 'virtual' })
  })

  it('drops an invented label and falls back on bad enums', () => {
    const r = parseStructuredReply(
      { reply: 'x', lead_label: 'vip', priority: 'mega', intent_level: 'huge', action_type: 'DANCE' },
      { labelKeys: ['interested'] },
    )
    expect(r.leadLabel).toBeNull()
    expect(r.priority).toBe('normal')
    expect(r.intentLevel).toBe('low')
    expect(r.actionType).toBe('AI_CONTINUE')
    expect(r.needsHuman).toBe(false)
  })

  it('a human-type action implies needs_human unless explicitly false', () => {
    expect(parseStructuredReply({ action_type: 'CALL' }, { labelKeys: [] }).needsHuman).toBe(true)
    expect(parseStructuredReply({ action_type: 'CALL', needs_human: false }, { labelKeys: [] }).needsHuman).toBe(false)
  })

  it('the respond schema enumerates only the account labels', () => {
    const schema = respondToolSchema(['a', 'b']) as { properties: { lead_label: { enum: unknown[] } } }
    expect(schema.properties.lead_label.enum).toEqual(['a', 'b', null])
  })
})

describe('generateStructured', () => {
  beforeEach(() => {
    h.openai.mockReset()
    h.anthropic.mockReset()
  })

  it('runs look-up tools, feeds results back, and returns the respond payload with summed usage', async () => {
    h.openai
      .mockResolvedValueOnce({
        calls: [{ id: 'c1', name: 'search_items', input: { query: 'inglés' } }],
        text: '',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      })
      .mockResolvedValueOnce({
        calls: [{ id: 'c2', name: 'respond', input: { reply: 'Cuesta S/ 350', priority: 'high', item_id: 'i1' } }],
        text: '',
        usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
      })
    const runTool = vi.fn(async () => ({ items: [{ id: 'i1', name: 'Inglés', price: 350 }] }))

    const r = await generateStructured({
      config,
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'cuánto cuesta inglés' }],
      tools: [{ name: 'search_items', description: 'd', schema: { type: 'object' } }],
      runTool,
      labelKeys: ['interested'],
    })

    expect(runTool).toHaveBeenCalledWith({ id: 'c1', name: 'search_items', input: { query: 'inglés' } })
    expect(r.structured.reply).toBe('Cuesta S/ 350')
    expect(r.structured.itemId).toBe('i1')
    expect(r.toolRounds).toBe(1)
    expect(r.usage).toEqual({ promptTokens: 30, completionTokens: 10, totalTokens: 40 })

    // Second call must carry the tool round back to the provider, and
    // after the cap only `respond` is offered.
    const second = h.openai.mock.calls[1][0]
    expect(second.rounds).toHaveLength(1)
    expect(second.rounds[0].results[0].output).toEqual({ items: [{ id: 'i1', name: 'Inglés', price: 350 }] })
  })

  it('forces respond after the tool-round cap', async () => {
    h.openai.mockImplementation(async (args: { tools: { name: string }[] }) => {
      const onlyRespond = args.tools.length === 1 && args.tools[0].name === 'respond'
      return onlyRespond
        ? { calls: [{ id: 'r', name: 'respond', input: { reply: 'ok' } }], text: '', usage: null }
        : { calls: [{ id: 's', name: 'search_items', input: { query: 'x' } }], text: '', usage: null }
    })
    const r = await generateStructured({
      config,
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hola' }],
      tools: [{ name: 'search_items', description: 'd', schema: {} }],
      runTool: async () => ({ items: [] }),
      labelKeys: [],
      maxToolRounds: 2,
    })
    expect(r.toolRounds).toBe(2)
    expect(r.structured.reply).toBe('ok')
    expect(h.openai).toHaveBeenCalledTimes(3)
  })

  it('keeps prose when the model answers without any tool call', async () => {
    h.anthropic.mockResolvedValueOnce({ calls: [], text: 'Hola, ¿en qué te ayudo?', usage: null })
    const r = await generateStructured({
      config: { ...config, provider: 'anthropic' },
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'hola' }],
      tools: [],
      runTool: async () => ({}),
      labelKeys: [],
    })
    expect(r.structured.reply).toBe('Hola, ¿en qué te ayudo?')
    expect(r.structured.needsHuman).toBe(false)
  })
})
