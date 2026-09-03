import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { reopenClosedConversation } from './reopen'

/**
 * Regression cover for issue #409's "closed conversation lockout": an
 * inbound message bumped `unread_count` but never touched `status`, so a
 * closed thread accumulated unread customer messages while still reading
 * as resolved and staying out of the inbox's Open filter.
 *
 * Since migration 040 the reopen also restores ownership: an assigned
 * thread goes back to its person (human_active), an unassigned one back
 * to the assistant (ai_active). That is two guarded UPDATEs of which
 * exactly one can match, so these tests model a row that is either
 * assigned or not and assert on the one that fired.
 */

interface Recorded {
  table: string
  payload: Record<string, unknown> | null
  filters: [string, unknown][]
}

/**
 * Chainable stub shaped like the bit of postgrest this touches. `assigned`
 * says which of the two guarded updates the "database" would match.
 */
function stubClient(
  opts: { error?: { message: string } | null; assigned?: boolean } = {},
) {
  const { error = null, assigned = false } = opts
  const calls: Recorded[] = []

  const client = {
    from(table: string) {
      const rec: Recorded = { table, payload: null, filters: [] }
      calls.push(rec)
      let matches = true
      const builder = {
        update(payload: Record<string, unknown>) {
          rec.payload = payload
          return builder
        },
        eq(column: string, value: unknown) {
          rec.filters.push([column, value])
          return builder
        },
        is(column: string, value: unknown) {
          rec.filters.push([`is:${column}`, value])
          // `.is('assigned_agent_id', null)` matches only unassigned rows.
          if (column === 'assigned_agent_id' && value === null) matches = !assigned
          return builder
        },
        not(column: string, op: string, value: unknown) {
          rec.filters.push([`not:${column}:${op}`, value])
          // `.not('assigned_agent_id','is',null)` matches only assigned rows.
          if (column === 'assigned_agent_id' && op === 'is' && value === null) matches = assigned
          return builder
        },
        select() {
          return Promise.resolve({
            data: error || !matches ? [] : [{ id: 'conv-1' }],
            error,
          })
        },
      }
      return builder
    },
  }

  return { client: client as unknown as SupabaseClient, calls }
}

describe('reopenClosedConversation', () => {
  it('flips a closed, unassigned conversation back to open and to the assistant', async () => {
    const { client, calls } = stubClient({ assigned: false })

    const reopened = await reopenClosedConversation(client, {
      id: 'conv-1',
      status: 'closed',
    })

    expect(reopened).toBe(true)
    // One update per ownership branch; both target conversations.
    expect(calls).toHaveLength(2)
    expect(calls.every((c) => c.table === 'conversations')).toBe(true)
    const unassignedBranch = calls.find((c) => c.payload?.handoff_state === 'ai_active')
    expect(unassignedBranch?.payload).toMatchObject({
      status: 'open',
      handoff_state: 'ai_active',
      handoff_reason: 'reopened_by_inbound',
    })
    expect(unassignedBranch?.payload).toHaveProperty('updated_at')
  })

  it('hands a closed, assigned conversation back to its person', async () => {
    const { client, calls } = stubClient({ assigned: true })

    const reopened = await reopenClosedConversation(client, {
      id: 'conv-1',
      status: 'closed',
    })

    expect(reopened).toBe(true)
    const assignedBranch = calls.find((c) => c.payload?.handoff_state === 'human_active')
    expect(assignedBranch?.payload).toMatchObject({ status: 'open' })
    expect(assignedBranch?.filters).toContainEqual(['not:assigned_agent_id:is', null])
  })

  it('guards every write on the row still being closed', async () => {
    // The caller read the row earlier in the request. Without this filter,
    // two concurrent inbound deliveries both holding a stale
    // `status: 'closed'` could write 'open' over an agent's re-close.
    const { client, calls } = stubClient()

    await reopenClosedConversation(client, { id: 'conv-1', status: 'closed' })

    for (const call of calls) {
      expect(call.filters).toContainEqual(['id', 'conv-1'])
      expect(call.filters).toContainEqual(['status', 'closed'])
    }
  })

  it.each(['open', 'pending'])(
    'issues no query for a %s conversation',
    async (status) => {
      const { client, calls } = stubClient()

      const reopened = await reopenClosedConversation(client, {
        id: 'conv-1',
        status,
      })

      expect(reopened).toBe(false)
      expect(calls).toEqual([])
    },
  )

  it('issues no query when status is missing', async () => {
    const { client, calls } = stubClient()

    expect(await reopenClosedConversation(client, { id: 'conv-1' })).toBe(false)
    expect(calls).toEqual([])
  })

  it('swallows a failed update so inbound processing continues', async () => {
    // Throwing here would abort the webhook and make Meta redeliver the
    // message — a worse outcome than a thread that stays closed.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { client } = stubClient({ error: { message: 'permission denied' } })

    await expect(
      reopenClosedConversation(client, { id: 'conv-1', status: 'closed' }),
    ).resolves.toBe(false)

    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
