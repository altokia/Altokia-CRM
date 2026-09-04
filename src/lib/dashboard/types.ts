// Shared result shapes the dashboard components consume. Centralised
// here so each component stays thin and the page-level loader wires
// them up without type gymnastics.

export interface MetricDelta {
  current: number
  previous: number
}

export interface MetricsBundle {
  activeConversations: MetricDelta
  newContactsToday: MetricDelta
  openDealsValue: number
  openDealsCount: number
  messagesSentToday: MetricDelta
}

export interface ConversationsSeriesPoint {
  day: string // YYYY-MM-DD local
  incoming: number
  outgoing: number
}

export interface PipelineStageSlice {
  id: string
  name: string
  color: string
  dealCount: number
  totalValue: number
}

export interface PipelineDonutData {
  stages: PipelineStageSlice[]
  totalValue: number
}

export interface ResponseTimeBucket {
  /** 0 = Mon … 6 = Sun (Monday-first). */
  dow: number
  /** Average first-response time in minutes. Null means no samples. */
  avgMinutes: number | null
  samples: number
}

export interface ResponseTimeSummary {
  buckets: ResponseTimeBucket[]
  thisWeekAvg: number | null
  lastWeekAvg: number | null
}

export type ActivityKind =
  | 'message'
  | 'deal'
  | 'broadcast'
  | 'automation'
  | 'contact'

export interface ActivityItem {
  id: string
  kind: ActivityKind
  /** Primary line of text rendered in the feed. Pre-formatted. */
  text: string
  /** ISO timestamp the item happened at, drives relative-time + sort. */
  at: string
  /** Optional deep-link for the whole row (not all items have a target). */
  href?: string
}

// The shapes below all come from ONE call: the
// `account_operations_metrics()` RPC returns them as a single JSONB
// object. They are aggregated in SQL rather than here because every
// "today" / "this month" boundary has to be resolved in the account's
// timezone, which the browser (or the server's clock) cannot be trusted
// to know. Keys arrive snake_case; mapping them is the loader's job.

export interface OperationsLeadLabelCount {
  key: string
  name: string
  color: string
  count: number
}

export interface OperationsLeads {
  newToday: number
  open: number
  highPriority: number
  followUpOverdue: number
  followUpToday: number
  wonThisMonth: number
  wonValueThisMonth: number
  /** Every label on the account, including zero-count ones — the UI decides what to hide. */
  byLabel: OperationsLeadLabelCount[]
}

export interface OperationsConversations {
  waitingForHuman: number
  aiActive: number
  humanActive: number
  unassignedWaiting: number
  /** Longest current wait in whole minutes. Null means nobody is waiting. */
  longestWaitMinutes: number | null
}

export interface OperationsTaskTypeCount {
  actionType: string
  count: number
}

export interface OperationsTasks {
  open: number
  pending: number
  overdue: number
  dueToday: number
  byActionType: OperationsTaskTypeCount[]
}

export interface OperationsAi {
  repliesToday: number
  handoffsToday: number
  conversationsHandledToday: number
  /**
   * True when the caller is not an admin. ai_usage_log is admin-only by
   * policy (033), so the two usage counters come back as zeros — the
   * panel must say "admins only" rather than show a zero the viewer
   * would read as "the assistant did nothing today". Handoffs are
   * counted off tasks and stay accurate for everyone.
   */
  restricted: boolean
}

export interface OperationsMetrics {
  leads: OperationsLeads
  conversations: OperationsConversations
  tasks: OperationsTasks
  ai: OperationsAi
  /** IANA zone the day/month boundaries above were computed in. */
  timezone: string
  generatedAt: string
}
