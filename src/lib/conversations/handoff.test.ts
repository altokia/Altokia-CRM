import { describe, expect, it, vi } from 'vitest'
import { assistantMayReply, transitionHandoff } from './handoff'

/**
 * A minimal chainable stand-in for the Supabase query builder that
 * records every update and its filters, so the tests assert on WHAT
 * would be written rather than on network behaviour.
 */
function fakeDb(claimMatches = true) {
  const calls: Array<{ patch: Record<string, unknown>; filters: string[] }> = []
  const builder = (patch: Record<string, unknown>) => {
    const call = { patch, filters: [] as string[] }
    calls.push(call)
    const chain: Record<string, unknown> = {}
    const self = (name: string) => (...args: unknown[]) => {
      call.filters.push(`${name}(${args.map(String).join(',')})`)
      return chain
    }
    chain.eq = self('eq')
    chain.is = self('is')
    chain.select = () =>
      Promise.resolve({ data: claimMatches ? [{ id: 'c1' }] : [], error: null })
    // Awaiting the chain directly (no .select) resolves like PostgREST.
    chain.then = (resolve: (v: unknown) => void) => resolve({ error: null })
    return chain
  }
  const db = {
    from: vi.fn(() => ({ update: (patch: Record<string, unknown>) => builder(patch) })),
  }
  return { db: db as never, calls }
}

describe('transitionHandoff', () => {
  it('human_active with a direct assignee writes state and assignee together', async () => {
    const { db, calls } = fakeDb()
    const r = await transitionHandoff(db, {
      conversationId: 'c1',
      accountId: 'a1',
      to: 'human_active',
      reason: 'agent_assigned',
      assignTo: 'u1',
    })
    expect(r).toEqual({ state: 'human_active', assigned: true })
    expect(calls).toHaveLength(1)
    expect(calls[0].patch).toMatchObject({
      handoff_state: 'human_active',
      ai_autoreply_disabled: true,
      assigned_agent_id: 'u1',
      waiting_since: null,
      handoff_reason: 'agent_assigned',
    })
    expect(calls[0].filters).toEqual(['eq(id,c1)', 'eq(account_id,a1)'])
  })

  it('only-if-unassigned never skips the state change and reports whether it won the claim', async () => {
    const lost = fakeDb(false)
    const r1 = await transitionHandoff(lost.db, {
      conversationId: 'c1',
      to: 'human_active',
      reason: 'agent_replied',
      assignTo: 'u1',
      onlyIfUnassigned: true,
    })
    expect(r1.assigned).toBe(false)
    // First UPDATE = the state (no assignee), second = the guarded claim.
    expect(lost.calls[0].patch).not.toHaveProperty('assigned_agent_id')
    expect(lost.calls[0].patch.handoff_state).toBe('human_active')
    expect(lost.calls[1].patch).toMatchObject({ assigned_agent_id: 'u1' })
    expect(lost.calls[1].filters).toContain('is(assigned_agent_id,null)')

    const won = fakeDb(true)
    const r2 = await transitionHandoff(won.db, {
      conversationId: 'c1',
      to: 'human_active',
      assignTo: 'u1',
      onlyIfUnassigned: true,
    })
    expect(r2.assigned).toBe(true)
  })

  it('waiting_for_human stands the assistant down, stamps waiting_since and keeps status=pending in step', async () => {
    const { db, calls } = fakeDb()
    await transitionHandoff(db, {
      conversationId: 'c1',
      to: 'waiting_for_human',
      reason: 'ai_requested',
      summary: 'needs a call',
    })
    const p = calls[0].patch
    expect(p.handoff_state).toBe('waiting_for_human')
    expect(p.ai_autoreply_disabled).toBe(true)
    expect(p.status).toBe('pending')
    expect(p.ai_handoff_summary).toBe('needs a call')
    expect(typeof p.waiting_since).toBe('string')
    // An automated handoff must never stomp an existing assignee.
    expect(p).not.toHaveProperty('assigned_agent_id')
  })

  it('ai_active releases the assignee and resets the reply budget', async () => {
    const { db, calls } = fakeDb()
    await transitionHandoff(db, { conversationId: 'c1', to: 'ai_active', reason: 'manual_resume' })
    expect(calls[0].patch).toMatchObject({
      handoff_state: 'ai_active',
      ai_autoreply_disabled: false,
      assigned_agent_id: null,
      ai_reply_count: 0,
      ai_handoff_summary: null,
      waiting_since: null,
    })
  })

  it('closed also closes the legacy status', async () => {
    const { db, calls } = fakeDb()
    await transitionHandoff(db, { conversationId: 'c1', to: 'closed' })
    expect(calls[0].patch).toMatchObject({ handoff_state: 'closed', status: 'closed' })
  })
})

describe('assistantMayReply', () => {
  it('allows only ai_active', () => {
    expect(assistantMayReply('ai_active')).toBe(true)
    expect(assistantMayReply('waiting_for_human')).toBe(false)
    expect(assistantMayReply('human_active')).toBe(false)
    expect(assistantMayReply('closed')).toBe(false)
    expect(assistantMayReply(undefined)).toBe(false)
  })
})
