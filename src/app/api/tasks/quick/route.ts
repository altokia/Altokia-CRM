import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { isValidTimeZone } from '@/lib/availability'
import { setLeadFollowUp } from '@/lib/leads'
import { createTask, TaskValidationError } from '@/lib/tasks'
import { parseFollowUp } from '@/lib/tasks/parse-followup'
import type { Task } from '@/types'

/**
 * POST /api/tasks/quick — a follow-up typed in one line.
 *
 *   { text, contact_id?, conversation_id?, assign_to? }
 *
 * "recuérdame mañana llamar a Juan" becomes a FOLLOW_UP task due
 * tomorrow, assigned to the caller (or `assign_to`), linked to the
 * contact when one was given or when the name in the text matches
 * exactly one contact, and stamped on that contact's open lead. Nothing
 * is guessed: an ambiguous name leaves the task unlinked, and a text
 * with no recognisable date is a 400 with `code: "no_date"` so the UI
 * can show examples.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent')

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    const text = typeof body?.text === 'string' ? body.text.trim() : ''
    if (!text) return NextResponse.json({ error: 'text is required' }, { status: 400 })
    if (text.length > 500) return NextResponse.json({ error: 'text is too long' }, { status: 400 })

    const contactIdIn = typeof body?.contact_id === 'string' ? body.contact_id : null
    const conversationIdIn = typeof body?.conversation_id === 'string' ? body.conversation_id : null
    const assignTo =
      body?.assign_to === undefined || body?.assign_to === null || body?.assign_to === 'me'
        ? ctx.userId
        : typeof body?.assign_to === 'string'
          ? body.assign_to
          : null
    if (!assignTo) return NextResponse.json({ error: 'assign_to must be a user id or "me"' }, { status: 400 })

    // The account's clock, not the server's.
    const { data: acct } = await ctx.supabase
      .from('accounts')
      .select('timezone')
      .eq('id', ctx.accountId)
      .maybeSingle()
    const timeZone = acct?.timezone && isValidTimeZone(acct.timezone) ? (acct.timezone as string) : 'UTC'

    const parsed = parseFollowUp(text, { now: new Date(), timeZone, fallbackTitle: 'Seguimiento' })
    if (!parsed) {
      return NextResponse.json({ error: 'No date found in the text', code: 'no_date' }, { status: 400 })
    }

    // Who this is about.
    let contact: { id: string; name: string | null; phone: string | null } | null = null
    if (contactIdIn) {
      const { data } = await ctx.supabase
        .from('contacts')
        .select('id, name, phone')
        .eq('id', contactIdIn)
        .eq('account_id', ctx.accountId)
        .maybeSingle()
      if (!data) return NextResponse.json({ error: 'Contact not found' }, { status: 400 })
      contact = data
    } else if (parsed.personHint) {
      const { data } = await ctx.supabase
        .from('contacts')
        .select('id, name, phone')
        .eq('account_id', ctx.accountId)
        .ilike('name', `%${parsed.personHint}%`)
        .limit(2)
      if (data && data.length === 1) contact = data[0]
    }

    let conversationId = conversationIdIn
    if (!conversationId && contact) {
      const { data } = await ctx.supabase
        .from('conversations')
        .select('id')
        .eq('account_id', ctx.accountId)
        .eq('contact_id', contact.id)
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle()
      conversationId = (data?.id as string | undefined) ?? null
    }

    if (assignTo !== ctx.userId) {
      const { data: member } = await ctx.supabase
        .from('profiles')
        .select('user_id')
        .eq('account_id', ctx.accountId)
        .eq('user_id', assignTo)
        .maybeSingle()
      if (!member) return NextResponse.json({ error: 'That user is not a member of this account' }, { status: 400 })
    }

    const dealId = contact
      ? await setLeadFollowUp(ctx.supabase, {
          accountId: ctx.accountId,
          contactId: contact.id,
          followUpAt: parsed.dueAt,
          nextAction: parsed.title,
        })
      : null

    let task: Task
    try {
      task = await createTask(ctx.supabase, {
        accountId: ctx.accountId,
        actionType: 'FOLLOW_UP',
        title: parsed.title,
        details: text,
        priority: 'normal',
        conversationId,
        contactId: contact?.id ?? null,
        dealId,
        assignedTo: assignTo,
        createdBy: ctx.userId,
        source: 'manual',
        dueAt: parsed.dueAt,
      })
    } catch (err) {
      if (err instanceof TaskValidationError) return NextResponse.json({ error: err.message }, { status: 400 })
      throw err
    }

    // Same audit trail as a task created through the form.
    await ctx.supabase.from('assignment_events').insert({
      account_id: ctx.accountId,
      task_id: task.id,
      conversation_id: task.conversation_id,
      assigned_to: assignTo,
      strategy: 'manual',
      decided_by: 'manual',
      reason: 'quick:direct',
      candidates: [],
    })

    return NextResponse.json(
      {
        task,
        due_at: parsed.dueAt.toISOString(),
        has_time: parsed.hasTime,
        contact,
        deal_id: dealId,
      },
      { status: 201 },
    )
  } catch (err) {
    return toErrorResponse(err)
  }
}
