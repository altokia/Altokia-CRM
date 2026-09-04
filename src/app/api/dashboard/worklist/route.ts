import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import {
  isWorklistKey,
  WORKLIST_MAX_LIMIT,
  WORKLIST_MAX_OFFSET,
  WORKLIST_PAGE_SIZE,
  type WorklistItem,
  type WorklistKey,
  type WorklistPage,
} from '@/lib/dashboard/worklist'

/**
 * GET /api/dashboard/worklist?list=…&offset=…&limit=…  — any member
 *
 * The rows behind the operations panel's counters. `account_operations_metrics()`
 * (044) returns totals only, so "Seguimientos vencidos: 7" had nowhere to lead;
 * this endpoint is where the seven live.
 *
 * Each list repeats the predicate of the counter it opens, verbatim, so the
 * number and the list can never disagree about what "overdue" means. The one
 * thing deliberately *not* copied from 044 is the account time zone: none of
 * these four counters has a day or month boundary in it — they all compare
 * against "right now", which is the same instant in every zone. `generatedAt`
 * is that instant, returned so the UI ages the rows against the same clock the
 * cut-off used.
 *
 * Always paginated, never unbounded: `limit` is capped and `offset` cannot walk
 * past WORKLIST_MAX_OFFSET. RLS scopes every query to the caller's account;
 * account_id is passed as well so the reads ride the per-account indexes.
 */

/** The three statuses that mean "open work" everywhere (041). */
const OPEN_TASK_STATUSES = ['pending', 'assigned', 'in_progress']

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const url = new URL(request.url)

    const list = url.searchParams.get('list') ?? ''
    if (!isWorklistKey(list)) {
      return NextResponse.json({ error: `Unknown list "${list}"` }, { status: 400 })
    }
    const limit = clamp(url.searchParams.get('limit'), WORKLIST_PAGE_SIZE, 1, WORKLIST_MAX_LIMIT)
    const offset = clamp(url.searchParams.get('offset'), 0, 0, WORKLIST_MAX_OFFSET)

    // One clock for the whole answer: the cut-off below and the ages the
    // sheet renders both come from this instant.
    const generatedAt = new Date().toISOString()

    const [rows, people] = await Promise.all([
      loadRows(ctx, list, generatedAt, offset, limit),
      loadPeople(ctx),
    ])
    if (!rows) {
      return NextResponse.json({ error: 'Failed to load the list' }, { status: 500 })
    }

    // `hasMore` also has to respect the offset ceiling, or the last
    // "show more" would ask for a page the clamp above rewrites into the
    // previous one and the sheet would append the same rows for ever.
    const nextOffset = offset + rows.data.length
    const page: WorklistPage = {
      list,
      items: toItems(list, rows.data, people),
      total: rows.total,
      hasMore: nextOffset < rows.total && nextOffset <= WORKLIST_MAX_OFFSET,
      generatedAt,
    }
    return NextResponse.json(page)
  } catch (err) {
    return toErrorResponse(err)
  }
}

// ------------------------------------------------------------
// Reading
// ------------------------------------------------------------

type Ctx = Awaited<ReturnType<typeof getCurrentAccount>>

/** PostgREST returns an embedded 1:1 row as an object or a one-element array. */
type Embedded<T> = T | T[] | null

interface RawRow {
  id: string
  title?: string | null
  follow_up_at?: string | null
  due_at?: string | null
  waiting_since?: string | null
  next_action?: string | null
  details?: string | null
  last_message_text?: string | null
  assigned_to?: string | null
  assigned_agent_id?: string | null
  conversation_id?: string | null
  contact?: Embedded<{ name: string | null; phone: string | null }>
}

interface People {
  byProfileId: Map<string, string>
  byUserId: Map<string, string>
}

/**
 * The four queries. Each is the counter's own predicate plus an ordering
 * that puts the work which has waited longest on top — the 044 counters
 * have no order at all, and "oldest first" is the only one an operator
 * would accept from a queue.
 */
async function loadRows(
  ctx: Ctx,
  list: WorklistKey,
  now: string,
  offset: number,
  limit: number,
): Promise<{ data: RawRow[]; total: number } | null> {
  const from = offset
  const to = offset + limit - 1

  const query = (() => {
    switch (list) {
      case 'lead_followups_overdue':
        // "< now" drops NULL follow_up_at on its own, exactly as the
        // counter's FILTER clause does.
        return ctx.supabase
          .from('deals')
          .select(
            'id, title, follow_up_at, next_action, assigned_to, conversation_id, contact:contacts(name, phone)',
            { count: 'exact' },
          )
          .eq('account_id', ctx.accountId)
          .eq('status', 'open')
          .lt('follow_up_at', now)
          .order('follow_up_at', { ascending: true })
          // `id` breaks ties. Paging with .range() over a non-unique
          // sort key has no stable boundary: two rows sharing a
          // timestamp can both land on page 1 and page 2, or neither.
          .order('id', { ascending: true })
          .range(from, to)

      case 'tasks_overdue':
        return ctx.supabase
          .from('tasks')
          .select(
            'id, title, due_at, details, assigned_to, conversation_id, contact:contacts(name, phone)',
            { count: 'exact' },
          )
          .eq('account_id', ctx.accountId)
          .in('status', OPEN_TASK_STATUSES)
          .lt('due_at', now)
          .order('due_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to)

      case 'conversations_waiting':
      case 'conversations_unassigned': {
        let q = ctx.supabase
          .from('conversations')
          .select(
            'id, waiting_since, assigned_agent_id, last_message_text, contact:contacts(name, phone)',
            { count: 'exact' },
          )
          .eq('account_id', ctx.accountId)
          .eq('handoff_state', 'waiting_for_human')
        if (list === 'conversations_unassigned') q = q.is('assigned_agent_id', null)
        // waiting_since is nullable (a thread parked before 040 filled
        // it in); those rows sort last rather than pretending to be the
        // oldest wait in the queue.
        return q
          .order('waiting_since', { ascending: true, nullsFirst: false })
          .order('id', { ascending: true })
          .range(from, to)
      }

      default: {
        // Unreachable — `list` is validated against WORKLIST_KEYS before
        // we get here. The `never` binding is what makes adding a key
        // without a query a compile error instead of an empty panel.
        const unhandled: never = list
        throw new Error(`No query for worklist "${String(unhandled)}"`)
      }
    }
  })()

  const { data, count, error } = await query
  if (error) {
    console.error(`[GET /api/dashboard/worklist] ${list} fetch error:`, error)
    return null
  }
  return { data: (data ?? []) as unknown as RawRow[], total: count ?? 0 }
}

/**
 * Everyone who can own a row, indexed both ways — because the two
 * columns point at different tables. `deals.assigned_to` is a FK to
 * **profiles.id** (migration 002), while `tasks.assigned_to` and
 * `conversations.assigned_agent_id` are FKs to **auth.users.id** (041,
 * 040). Looking a deal's owner up by user_id would silently return
 * nobody for every row on the board.
 */
async function loadPeople(ctx: Ctx): Promise<People> {
  const byProfileId = new Map<string, string>()
  const byUserId = new Map<string, string>()

  const { data, error } = await ctx.supabase
    .from('profiles')
    .select('id, user_id, full_name')
    .eq('account_id', ctx.accountId)

  if (error) {
    // A row whose owner we can't name still beats no list at all: it
    // reads as unassigned, which is recoverable, where a 500 would hide
    // the whole queue over a cosmetic lookup.
    console.error('[GET /api/dashboard/worklist] profiles fetch error:', error)
    return { byProfileId, byUserId }
  }

  for (const p of (data ?? []) as { id: string; user_id: string; full_name: string }[]) {
    byProfileId.set(p.id, p.full_name)
    byUserId.set(p.user_id, p.full_name)
  }
  return { byProfileId, byUserId }
}

// ------------------------------------------------------------
// Shaping
// ------------------------------------------------------------

function toItems(list: WorklistKey, rows: RawRow[], people: People): WorklistItem[] {
  return rows.map((row): WorklistItem => {
    const who = contactLabel(row.contact)

    switch (list) {
      case 'lead_followups_overdue':
        return {
          id: row.id,
          title: row.title ?? '',
          contact: who,
          owner: lookup(people.byProfileId, row.assigned_to),
          since: row.follow_up_at ?? null,
          detail: row.next_action ?? null,
          // A lead that arrived over WhatsApp is worked in its thread;
          // one created by hand has no thread, so the board is the only
          // place it can be acted on.
          href: row.conversation_id ? `/inbox?c=${row.conversation_id}` : '/pipelines',
        }

      case 'tasks_overdue':
        return {
          id: row.id,
          title: row.title ?? '',
          contact: who,
          owner: lookup(people.byUserId, row.assigned_to),
          since: row.due_at ?? null,
          detail: row.details ?? null,
          // There is no per-task URL; "Mi trabajo" is where a task with
          // no conversation gets attended.
          href: row.conversation_id ? `/inbox?c=${row.conversation_id}` : '/my-work',
        }

      case 'conversations_waiting':
      case 'conversations_unassigned':
        return {
          id: row.id,
          // A conversation *is* its contact, so the name becomes the
          // title and `contact` stays null rather than printing it twice.
          title: who ?? '',
          contact: null,
          owner: lookup(people.byUserId, row.assigned_agent_id),
          since: row.waiting_since ?? null,
          detail: row.last_message_text ?? null,
          href: `/inbox?c=${row.id}`,
        }

      default: {
        const unhandled: never = list
        throw new Error(`No row shape for worklist "${String(unhandled)}"`)
      }
    }
  })
}

function lookup(index: Map<string, string>, id: string | null | undefined): string | null {
  if (!id) return null
  return index.get(id) ?? null
}

/** Name, else phone. Null when there is no contact to name at all. */
function contactLabel(contact: RawRow['contact']): string | null {
  const row = Array.isArray(contact) ? contact[0] : contact
  if (!row) return null
  return row.name?.trim() || row.phone?.trim() || null
}

function clamp(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}
