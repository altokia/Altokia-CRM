import { describe, expect, it } from 'vitest'
import { mapOperations } from './queries'

// The RPC payload is the contract between migration 044 and the
// dashboard. These tests pin both halves of it: the happy path (every
// key present, snake_case → camelCase) and the degraded paths, because
// mapOperations is the only thing standing between a schema drift and a
// crashed server component.

describe('mapOperations', () => {
  it('maps a complete payload key by key', () => {
    const out = mapOperations({
      leads: {
        new_today: 12,
        open: 84,
        high_priority: 9,
        follow_up_overdue: 4,
        follow_up_today: 6,
        won_this_month: 7,
        won_value_this_month: 15250.5,
        by_label: [
          { key: 'hot', name: 'Caliente', color: '#ef4444', count: 5 },
          { key: 'cold', name: 'Frio', color: '#3b82f6', count: 0 },
        ],
      },
      conversations: {
        waiting_for_human: 3,
        ai_active: 21,
        human_active: 5,
        unassigned_waiting: 2,
        longest_wait_minutes: 47,
      },
      tasks: {
        open: 14,
        pending: 8,
        overdue: 3,
        due_today: 5,
        by_action_type: [
          { action_type: 'HUMAN_CHAT', count: 9 },
          { action_type: 'CALLBACK', count: 5 },
        ],
      },
      ai: {
        replies_today: 132,
        handoffs_today: 11,
        conversations_handled_today: 40,
      },
      timezone: 'America/Lima',
      generated_at: '2026-09-03T14:05:00.000Z',
    })

    expect(out).toEqual({
      leads: {
        newToday: 12,
        open: 84,
        highPriority: 9,
        followUpOverdue: 4,
        followUpToday: 6,
        wonThisMonth: 7,
        wonValueThisMonth: 15250.5,
        byLabel: [
          { key: 'hot', name: 'Caliente', color: '#ef4444', count: 5 },
          { key: 'cold', name: 'Frio', color: '#3b82f6', count: 0 },
        ],
      },
      conversations: {
        waitingForHuman: 3,
        aiActive: 21,
        humanActive: 5,
        unassignedWaiting: 2,
        longestWaitMinutes: 47,
      },
      tasks: {
        open: 14,
        pending: 8,
        overdue: 3,
        dueToday: 5,
        byActionType: [
          { actionType: 'HUMAN_CHAT', count: 9 },
          { actionType: 'CALLBACK', count: 5 },
        ],
      },
      ai: {
        repliesToday: 132,
        handoffsToday: 11,
        conversationsHandledToday: 40,
        restricted: false,
      },
      timezone: 'America/Lima',
      generatedAt: '2026-09-03T14:05:00.000Z',
    })
  })

  it('carries the admin-only flag through, and only on an explicit true', () => {
    // ai_usage_log is admin-only by policy (033), so for a viewer the
    // RPC returns zeros plus restricted:true. The panel needs to tell
    // that apart from a genuinely quiet day, so the flag is never
    // inferred from the counters.
    const restricted = mapOperations({
      ai: { replies_today: 0, handoffs_today: 4, conversations_handled_today: 0, restricted: true },
    })
    expect(restricted.ai.restricted).toBe(true)
    expect(restricted.ai.handoffsToday).toBe(4)

    // Anything that is not exactly `true` means "not restricted" — an
    // older deploy with no such key keeps showing its numbers.
    for (const value of [undefined, null, 'true', 1, {}]) {
      expect(mapOperations({ ai: { restricted: value } }).ai.restricted).toBe(false)
    }
  })

  it('keeps zero-count labels: hiding them is the UI call, not the loader one', () => {
    const out = mapOperations({
      leads: {
        by_label: [{ key: 'cold', name: 'Frio', color: '#3b82f6', count: 0 }],
      },
    })
    expect(out.leads.byLabel).toHaveLength(1)
    expect(out.leads.byLabel[0].count).toBe(0)
  })

  it('fills an empty object with zeros rather than undefined', () => {
    const out = mapOperations({})

    expect(out.leads).toEqual({
      newToday: 0,
      open: 0,
      highPriority: 0,
      followUpOverdue: 0,
      followUpToday: 0,
      wonThisMonth: 0,
      wonValueThisMonth: 0,
      byLabel: [],
    })
    expect(out.conversations).toEqual({
      waitingForHuman: 0,
      aiActive: 0,
      humanActive: 0,
      unassignedWaiting: 0,
      longestWaitMinutes: null,
    })
    expect(out.tasks).toEqual({
      open: 0,
      pending: 0,
      overdue: 0,
      dueToday: 0,
      byActionType: [],
    })
    expect(out.ai).toEqual({
      repliesToday: 0,
      handoffsToday: 0,
      conversationsHandledToday: 0,
      // Absent means "not restricted": only the RPC's explicit `true`
      // hides the counters, so a payload from an older deploy keeps
      // showing them rather than silently blanking the card.
      restricted: false,
    })
    expect(out.timezone).toBe('UTC')
    expect(out.generatedAt).toBe('')
  })

  it('survives null and other non-objects without throwing', () => {
    for (const raw of [null, undefined, 'boom', 42, []]) {
      expect(() => mapOperations(raw)).not.toThrow()
    }

    const out = mapOperations(null)
    expect(out.leads.open).toBe(0)
    expect(out.leads.byLabel).toEqual([])
    expect(out.tasks.byActionType).toEqual([])
    expect(out.conversations.longestWaitMinutes).toBeNull()
    expect(out.timezone).toBe('UTC')
  })

  it('coerces the numeric-as-string values Postgres emits, and drops garbage to 0', () => {
    const out = mapOperations({
      leads: {
        // `numeric` columns (and SUM over them) arrive JSON-encoded as
        // strings; treating them as numbers would concatenate or show 0.
        won_value_this_month: '15250.50',
        new_today: '12',
        open: '84',
        high_priority: null,
        follow_up_overdue: 'not-a-number',
        by_label: null,
      },
      conversations: { longest_wait_minutes: '47', waiting_for_human: '3' },
      tasks: { open: '14', by_action_type: null },
      ai: { replies_today: '132' },
      timezone: null,
      generated_at: null,
    })

    expect(out.leads.wonValueThisMonth).toBe(15250.5)
    expect(out.leads.newToday).toBe(12)
    expect(out.leads.open).toBe(84)
    expect(out.leads.highPriority).toBe(0)
    expect(out.leads.followUpOverdue).toBe(0)
    expect(out.leads.byLabel).toEqual([])
    expect(out.conversations.longestWaitMinutes).toBe(47)
    expect(out.conversations.waitingForHuman).toBe(3)
    expect(out.tasks.open).toBe(14)
    expect(out.tasks.byActionType).toEqual([])
    expect(out.ai.repliesToday).toBe(132)
    expect(out.timezone).toBe('UTC')
    expect(out.generatedAt).toBe('')
  })

  it('reads an unparseable wait as "nobody waiting" instead of zero minutes', () => {
    expect(
      mapOperations({ conversations: { longest_wait_minutes: 'soon' } })
        .conversations.longestWaitMinutes,
    ).toBeNull()
    expect(
      mapOperations({ conversations: { longest_wait_minutes: 0 } })
        .conversations.longestWaitMinutes,
    ).toBe(0)
  })

  it('repairs malformed rows inside the label and task arrays', () => {
    const out = mapOperations({
      leads: { by_label: [null, { key: 'hot' }, 'nope'] },
      tasks: { by_action_type: [{ action_type: 'CALLBACK', count: '5' }, 7] },
    })

    expect(out.leads.byLabel).toEqual([
      { key: '', name: '', color: '', count: 0 },
      { key: 'hot', name: '', color: '', count: 0 },
      { key: '', name: '', color: '', count: 0 },
    ])
    expect(out.tasks.byActionType).toEqual([
      { actionType: 'CALLBACK', count: 5 },
      { actionType: '', count: 0 },
    ])
  })
})
