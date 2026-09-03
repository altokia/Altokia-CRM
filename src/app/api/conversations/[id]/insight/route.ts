import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { isTaskPriority } from '@/lib/tasks'

/**
 * /api/conversations/[id]/insight — the assistant's reading of a thread.
 *
 *   GET                                               any member
 *   PATCH { lead_label_key?, priority?, next_action? }  agent+
 *
 * A PATCH of the label sets `lead_label_locked`, so the assistant stops
 * overwriting what a person decided until they change it again (or
 * clear the lock by sending lead_label_key: null).
 */

const COLUMNS =
  'conversation_id, intent, intent_level, item_id, item_name, need, priority, preferences, collected_info, next_action, action_type, needs_human, lead_label_key, lead_label_locked, preferred_contact_time, summary, last_extracted_at, updated_at'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await getCurrentAccount()
    const { id } = await params
    const { data, error } = await ctx.supabase
      .from('conversation_insights')
      .select(COLUMNS)
      .eq('conversation_id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (error) {
      console.error('[GET /api/conversations/[id]/insight] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load insight' }, { status: 500 })
    }
    return NextResponse.json({ insight: data ?? null })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('agent')
    const { id } = await params
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const patch: Record<string, unknown> = {}
    if (body.lead_label_key !== undefined) {
      if (body.lead_label_key === null) {
        patch.lead_label_key = null
        patch.lead_label_locked = false
      } else {
        if (typeof body.lead_label_key !== 'string') {
          return NextResponse.json({ error: 'lead_label_key must be a string or null' }, { status: 400 })
        }
        const { data: label } = await ctx.supabase
          .from('lead_labels')
          .select('key')
          .eq('account_id', ctx.accountId)
          .eq('key', body.lead_label_key)
          .maybeSingle()
        if (!label) return NextResponse.json({ error: 'Unknown label' }, { status: 400 })
        patch.lead_label_key = body.lead_label_key
        patch.lead_label_locked = true
      }
    }
    if (body.priority !== undefined) {
      if (!isTaskPriority(body.priority)) {
        return NextResponse.json({ error: 'Unknown priority' }, { status: 400 })
      }
      patch.priority = body.priority
    }
    if (body.next_action !== undefined) {
      patch.next_action = typeof body.next_action === 'string' ? body.next_action.trim() || null : null
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }

    // The row may not exist yet (assistant never ran on this thread); a
    // human labelling it first is a fine reason to create it.
    const { data: conv } = await ctx.supabase
      .from('conversations')
      .select('id, contact_id')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (!conv) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })

    const { data, error } = await ctx.supabase
      .from('conversation_insights')
      .upsert(
        { conversation_id: id, account_id: ctx.accountId, contact_id: conv.contact_id, ...patch },
        { onConflict: 'conversation_id' },
      )
      .select(COLUMNS)
      .single()
    if (error) {
      console.error('[PATCH /api/conversations/[id]/insight] upsert error:', error)
      return NextResponse.json({ error: 'Failed to update insight' }, { status: 500 })
    }
    return NextResponse.json({ insight: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}
