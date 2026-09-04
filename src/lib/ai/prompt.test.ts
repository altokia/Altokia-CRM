import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from './defaults'
import { compilePersona } from './persona'

describe('AI conversation guidance', () => {
  it('adds natural Peruvian commerce language for a Peru persona', () => {
    const prompt = compilePersona({
      name: 'Ana',
      language: 'es',
      region: 'Perú',
    })

    expect(prompt).toContain('qué bacán')
    expect(prompt).toContain('Yape')
    expect(prompt).toContain('Do not force slang')
  })

  it('keeps commerce guardrails without exposing internal automation details', () => {
    const prompt = buildSystemPrompt({ mode: 'draft', userPrompt: null })

    expect(prompt).toContain('Yape, Plin')
    expect(prompt).toContain('Do not volunteer that you are automated')
    expect(prompt).toContain('offer to pass the conversation to a person')
    expect(prompt).toContain('never assume shipping')
  })
})