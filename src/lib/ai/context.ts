import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_text: string | null
}

/**
 * Fetch the last N text messages of a conversation and map them to the
 * provider-neutral chat shape. Customer messages become `user`; agent
 * and bot messages become `assistant`. Non-text messages (media,
 * templates, interactive) are excluded — they carry no text to model.
 *
 * Ordered oldest-first (chronological) so the transcript reads
 * naturally and the most recent customer message lands last.
 */
export async function buildConversationContext(
  db: SupabaseClient,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
): Promise<ChatMessage[]> {
  const { data, error } = await db
    .from('messages')
    .select('sender_type, content_text')
    .eq('conversation_id', conversationId)
    .eq('content_type', 'text')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const rows = ((data ?? []) as DbMessage[]).reverse()
  return rows
    .filter((m) => m.content_text && m.content_text.trim())
    .map((m) => ({
      role: m.sender_type === 'customer' ? 'user' : 'assistant',
      content: m.content_text!.trim(),
    }))
}

// ============================================================
// Commercial memory
// ============================================================

/**
 * What the business already knows about this contact, rendered as a
 * few plain lines for the prompt — or null when there is nothing
 * worth saying (a brand-new contact). Best-effort: any read failure
 * yields null rather than blocking the reply.
 *
 * Sources (all already in the schema): the contact row, the previous
 * structured reading (conversation_insights), the last human who owned
 * the thread, open deals, and tags.
 */
export async function buildMemory(
  db: SupabaseClient,
  args: { accountId: string; conversationId: string; contactId: string },
): Promise<string | null> {
  const { accountId, conversationId, contactId } = args
  try {
    const [contactRes, insightRes, convRes, dealsRes, tagsRes] = await Promise.all([
      db.from('contacts').select('name, company, created_at').eq('id', contactId).maybeSingle(),
      db
        .from('conversation_insights')
        .select('lead_label_key, item_name, need, next_action, preferred_contact_time, summary, last_extracted_at')
        .eq('conversation_id', conversationId)
        .maybeSingle(),
      db.from('conversations').select('assigned_agent_id, created_at').eq('id', conversationId).maybeSingle(),
      db
        .from('deals')
        .select('title, status, updated_at')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('updated_at', { ascending: false })
        .limit(3),
      db.from('contact_tags').select('tag:tags(name)').eq('contact_id', contactId).limit(10),
    ])

    const lines: string[] = []
    const contact = contactRes.data
    if (contact?.name) lines.push(`Name: ${contact.name}${contact.company ? ` (${contact.company})` : ''}`)

    const tags = (tagsRes.data ?? [])
      .map((r) => (r as { tag?: { name?: string } | { name?: string }[] | null }).tag)
      .flatMap((t) => (Array.isArray(t) ? t : t ? [t] : []))
      .map((t) => t?.name)
      .filter((n): n is string => !!n)
    if (tags.length) lines.push(`Tags: ${tags.join(', ')}`)

    const insight = insightRes.data
    if (insight?.last_extracted_at) {
      const when = new Date(insight.last_extracted_at as string).toISOString().slice(0, 10)
      const summaryText =
        insight.summary && typeof insight.summary === 'object' && 'text' in (insight.summary as object)
          ? String((insight.summary as { text?: unknown }).text ?? '')
          : ''
      lines.push(`Last contact: ${when}.${summaryText ? ` Summary then: ${summaryText}` : ''}`)
      if (insight.item_name) lines.push(`They were interested in: ${insight.item_name}`)
      if (insight.need) lines.push(`Their need: ${insight.need}`)
      if (insight.lead_label_key) lines.push(`Lead label: ${insight.lead_label_key}`)
      if (insight.next_action) lines.push(`Pending next step: ${insight.next_action}`)
      if (insight.preferred_contact_time) lines.push(`Prefers contact: ${insight.preferred_contact_time}`)
    }

    const assignee = convRes.data?.assigned_agent_id as string | null | undefined
    if (assignee) {
      const { data: profile } = await db.from('profiles').select('full_name').eq('user_id', assignee).maybeSingle()
      if (profile?.full_name) lines.push(`Their advisor: ${profile.full_name}`)
    }

    const deals = dealsRes.data ?? []
    if (deals.length) {
      lines.push(
        `Deals: ${deals.map((d) => `${d.title} (${d.status})`).join('; ')}`,
      )
    }

    // A fresh contact with only a name is not "memory" worth mentioning.
    const meaningful = lines.length > (contact?.name ? 1 : 0)
    return meaningful ? lines.join('\n') : null
  } catch (err) {
    console.warn('[ai memory] skipped:', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * Knowledge entries that apply to every conversation (hours, locations,
 * payment methods, the business description) — no retrieval needed.
 * Kept short: one line per entry, title + content, capped.
 */
export async function loadBusinessProfile(
  db: SupabaseClient,
  accountId: string,
  limit = 8,
): Promise<string[]> {
  try {
    const { data } = await db
      .from('ai_knowledge_documents')
      .select('kind, title, content')
      .eq('account_id', accountId)
      .in('kind', ['description', 'hours', 'location', 'payment'])
      .order('kind', { ascending: true })
      .limit(limit)
    return (data ?? []).map((d) => `${d.title}: ${String(d.content).trim().slice(0, 600)}`)
  } catch {
    return []
  }
}
