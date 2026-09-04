// The rows behind the operations panel's "someone is waiting" counters.
//
// Migration 044 answers *how many* overdue follow-ups, overdue tasks and
// waiting conversations an account has, and nothing more — which left
// the panel showing "7" with no way to find out which seven. This module
// is the contract for the list that opens when the counter is clicked:
// the route handler builds these rows, the sheet renders them, and
// neither half can drift from the other.
//
// Deliberately isomorphic: no Supabase, no next/headers, nothing a
// client component can't import.

export const WORKLIST_KEYS = [
  /** deals: open, follow_up_at already past. */
  'lead_followups_overdue',
  /** tasks: still open, due_at already past. */
  'tasks_overdue',
  /** conversations: handoff_state = waiting_for_human. */
  'conversations_waiting',
  /** the subset of the above that nobody has picked up. */
  'conversations_unassigned',
] as const

export type WorklistKey = (typeof WORKLIST_KEYS)[number]

export function isWorklistKey(value: string): value is WorklistKey {
  return (WORKLIST_KEYS as readonly string[]).includes(value)
}

/** Rows per page. One screenful of the sheet without scrolling. */
export const WORKLIST_PAGE_SIZE = 10
/** Hard ceiling on `limit`, so no caller can ask for the whole table. */
export const WORKLIST_MAX_LIMIT = 50
/**
 * Deepest page anyone may ask for. Past ~25 pages the list has stopped
 * being a to-do list and become a report; those live elsewhere.
 */
export const WORKLIST_MAX_OFFSET = 250

/**
 * One actionable row. Everything an operator needs to decide whether to
 * open it: whose it is, since when, and where to go.
 */
export interface WorklistItem {
  id: string
  /**
   * The headline. A deal or a task carries its own title; a
   * conversation is named after the person on the other end, which is
   * why `contact` is then left null instead of repeating it. Empty when
   * the record has no contact at all — the UI says so rather than
   * inventing a name.
   */
  title: string
  /** Who the row is about. Null when `title` already names them. */
  contact: string | null
  /** Who holds it. Null means nobody does — rendered as "unassigned". */
  owner: string | null
  /**
   * The instant the clock started running: the missed follow_up_at, the
   * missed due_at, or waiting_since. Null when the row has none.
   */
  since: string | null
  /** Context in the customer's own words: next action, last message. */
  detail: string | null
  /** Where the row gets worked — the conversation, or the queue. */
  href: string
}

export interface WorklistPage {
  list: WorklistKey
  items: WorklistItem[]
  /** Exact number of rows behind the counter, not just this page. */
  total: number
  hasMore: boolean
  /**
   * The server clock the "already past" cut-off was measured against.
   * The sheet ages every row from this instant rather than from
   * `Date.now()`, so the list and its timestamps agree with each other.
   */
  generatedAt: string
}

/**
 * Read one page. Throws on anything but 200 so the caller's `.catch`
 * gets a real error instead of a half-built page.
 */
export async function fetchWorklist(
  list: WorklistKey,
  offset: number,
  limit: number = WORKLIST_PAGE_SIZE,
): Promise<WorklistPage> {
  const params = new URLSearchParams({
    list,
    offset: String(offset),
    limit: String(limit),
  })
  const res = await fetch(`/api/dashboard/worklist?${params}`)
  if (!res.ok) throw new Error(`Worklist request failed (${res.status})`)
  return (await res.json()) as WorklistPage
}
