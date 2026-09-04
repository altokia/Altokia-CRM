// ============================================================
// The console's view of /api/platform/*
//
// One module holds every response shape the Altokia console reads, so
// the UI is programmed against the route contract rather than against
// whatever a given screen happened to destructure. Anything the
// contract does not promise is typed optional and rendered only when
// it actually arrives — the console must never invent a number.
//
// Deliberately does NOT import from `@/lib/platform`: that module
// pulls in the service-role client and `next/server`, which have no
// business in a browser bundle. The role list is small enough to
// restate here.
// ============================================================

export const PLATFORM_ROLES = ['support', 'billing', 'owner'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export function isPlatformRole(value: unknown): value is PlatformRole {
  return (
    typeof value === 'string' &&
    (PLATFORM_ROLES as readonly string[]).includes(value)
  );
}

export const ACCOUNT_STATUSES = [
  'trial',
  'active',
  'suspended',
  'cancelled',
] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

// ------------------------------------------------------------
// GET /api/platform/accounts
// ------------------------------------------------------------

export interface AccountListRow {
  id: string;
  name: string;
  status: AccountStatus;
  /** A `platform_plans.code` since migration 050 — no longer free text. */
  plan: string | null;
  created_at: string;
  provisioned_at: string | null;
  whatsapp: { connected: boolean; display_phone_number: string | null } | null;
  /**
   * How many people are inside. The route calls it `member_count`;
   * `people` is kept because the shape was written that way and the
   * console must not start printing "Falta" over a rename. Read them
   * through `accountPeople` rather than either field directly.
   */
  member_count?: number | null;
  people?: number | null;
  last_activity_at: string | null;
  /**
   * Set when Altokia blocked this client from signing in. Not promised
   * by the list contract, so the roster shows the "no access" marker
   * only when the route actually sends it — never inferred from
   * `status`, which is a different fact entirely.
   */
  access_revoked_at?: string | null;
}

export interface AccountListResponse {
  accounts: AccountListRow[];
  next_cursor?: string | null;
}

/** The head count for a roster row, or null when neither field came. */
export function accountPeople(row: AccountListRow): number | null {
  if (typeof row.member_count === 'number') return row.member_count;
  if (typeof row.people === 'number') return row.people;
  return null;
}

// ------------------------------------------------------------
// GET /api/platform/accounts/[id]
// ------------------------------------------------------------

export interface AccountRecord {
  id: string;
  name: string;
  status: AccountStatus;
  plan: string | null;
  limits?: Record<string, unknown> | null;
  trial_ends_at?: string | null;
  suspended_at?: string | null;
  suspended_reason?: string | null;
  external_ref?: string | null;
  operator_notes?: string | null;
  access_revoked_at?: string | null;
  access_revoked_reason?: string | null;
  credentials_issued_at?: string | null;
  created_at: string;
  provisioned_at?: string | null;
  timezone?: string | null;
  /**
   * Where this client's own CRM lives. Not in the route contract yet,
   * so the "open the client's CRM" action renders only when the API
   * supplies it — a button that goes nowhere is worse than no button.
   */
  crm_url?: string | null;
}

export interface AccountHealth {
  whatsapp_connected: boolean;
  whatsapp_status: string | null;
  whatsapp_error: string | null;
  webhook_recent: boolean;
  ai_configured: boolean;
  people: number | null;
}

export interface AccountUsage {
  messages_30d: number | null;
  ai_replies_30d: number | null;
  contacts: number | null;
  /** Optional: the storage tile appears only if the API measures it. */
  storage_bytes?: number | null;
}

export type AccessStatus = 'none' | 'pending' | 'granted';

export interface AccountAccess {
  status: AccessStatus;
  expires_at: string | null;
}

/**
 * What is already configured on the client's WhatsApp number. The GET
 * contract does not promise this block; when it is absent the webhook
 * address simply appears after the first successful save, which is the
 * response that definitely carries it.
 */
export interface AccountWhatsapp {
  phone_number_id?: string | null;
  display_phone_number?: string | null;
  waba_id?: string | null;
  app_id?: string | null;
  webhook_url?: string | null;
  verify_token?: string | null;
}

export interface AccountDetail {
  account: AccountRecord;
  health: AccountHealth;
  usage: AccountUsage;
  access?: AccountAccess | null;
  /**
   * What the detail route actually calls the consent grant. Both names
   * are accepted because the console must not blow up over which one
   * arrives — read them through `resolveAccess`.
   */
  support_access?: {
    status: string;
    expires_at?: string | null;
    active?: boolean;
  } | null;
  whatsapp?: AccountWhatsapp | null;
}

/**
 * The support-access state to render. Anything that is not positively
 * "pending" or a live grant reads as no access, which is the safe
 * direction: the card then offers to ask for it, rather than claiming
 * a permission the operator may not have.
 */
export function resolveAccess(detail: AccountDetail): AccountAccess {
  // Widened to the fields both shapes share, so neither name needs a
  // cast at the call site.
  const raw:
    | { status: string; expires_at?: string | null; active?: boolean }
    | null
    | undefined = detail.access ?? detail.support_access;
  if (!raw) return { status: 'none', expires_at: null };

  const expires = raw.expires_at ?? null;

  if (raw.status === 'pending') return { status: 'pending', expires_at: null };

  // `active` is the route's own has_platform_access() predicate. The
  // expiry check stays on the server: comparing against the clock here
  // would put a moving value in the render path, and the browser's
  // clock is not the one the grant is measured against anyway.
  const live = raw.status === 'granted' && raw.active !== false;

  return live
    ? { status: 'granted', expires_at: expires }
    : { status: 'none', expires_at: null };
}

export interface WhatsappSaveResponse {
  webhook_url: string;
  verify_token: string;
}

export interface AccessRequestResponse {
  status: AccessStatus;
}

// ------------------------------------------------------------
// GET /api/platform/plans — the tier catalogue (migration 050)
// ------------------------------------------------------------

/**
 * The five ceilings a tier can carry. Listed here, in this order,
 * because the console has to render a plan's contents in a stable
 * order and translate each line through `Platform.plan.limits.*`.
 *
 * A key ABSENT from `limits` means no ceiling — never zero. The
 * migration is explicit about it, and the difference is the whole
 * point: a plan with no `contacts` key is unlimited, a plan with
 * `contacts: 0` would be unusable.
 */
export const PLAN_LIMIT_KEYS = [
  'seats',
  'contacts',
  'ai_replies_per_month',
  'knowledge_documents',
  'catalog_items',
] as const;
export type PlanLimitKey = (typeof PLAN_LIMIT_KEYS)[number];

export interface PlatformPlan {
  code: string;
  name: string;
  description?: string | null;
  limits: Record<string, unknown>;
  price_note?: string | null;
  position?: number;
  is_active?: boolean;
}

export interface PlansResponse {
  plans: PlatformPlan[];
}

/**
 * The ceiling a plan puts on one resource, or `null` for "no ceiling".
 * Anything that is not a finite non-negative number — absent, null,
 * a string somebody typed into the jsonb — reads as unlimited, which
 * is the safe direction: the console never invents a limit that the
 * catalogue did not state.
 */
export function planLimit(
  limits: Record<string, unknown> | null | undefined,
  key: PlanLimitKey,
): number | null {
  const raw = limits?.[key];
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0
    ? raw
    : null;
}

// ------------------------------------------------------------
// POST /api/platform/accounts — cold provisioning
// ------------------------------------------------------------

/**
 * The one and only time this password exists outside Supabase Auth.
 * It is never persisted by us, never logged, and never written to the
 * audit log; the console shows it once and forgets it when the dialog
 * closes.
 */
export interface IssuedCredentials {
  email: string;
  password: string;
  login_url?: string | null;
}

export interface CreateAccountResponse {
  account: AccountRecord;
  owner: { user_id: string; email: string };
  credentials: IssuedCredentials;
}

// ------------------------------------------------------------
// /api/platform/accounts/[id]/credentials
// ------------------------------------------------------------

export interface AccountCredentials {
  owner_email: string | null;
  /** True when an operator created the login, not the customer. */
  issued_by_altokia: boolean;
  credentials_issued_at: string | null;
  access_revoked_at: string | null;
  access_revoked_reason: string | null;
  member_count: number | null;
}

/** PUT — a new password, shown once, same rules as above. */
export interface PasswordResetResponse {
  email: string;
  password: string;
}

/** POST { action: 'revoke' | 'restore' } */
export interface AccessChangeResponse {
  revoked: boolean;
  /** How many logins the change touched. */
  affected?: number;
}

// ------------------------------------------------------------
// GET /api/platform/audit
// ------------------------------------------------------------

export interface AuditEntryRow {
  id: string;
  action: string;
  detail: Record<string, unknown> | null;
  created_at: string;
  operator_name: string | null;
  account_name: string | null;
}

export interface AuditResponse {
  entries: AuditEntryRow[];
  next_cursor?: string | null;
}

// ------------------------------------------------------------
// GET /api/platform/operators
// ------------------------------------------------------------

export interface OperatorRow {
  user_id: string;
  role: PlatformRole;
  full_name: string | null;
  note: string | null;
  created_at: string;
}

export interface OperatorsResponse {
  operators: OperatorRow[];
}

// ------------------------------------------------------------
// Transport
// ------------------------------------------------------------

/**
 * Carries the HTTP status through, because the console reads meaning
 * from it: 404 from a platform route means "you are not staff" (the
 * access layer hides the console's existence rather than admitting to
 * it), 403 means "staff, but not senior enough for this one".
 */
export class PlatformRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'PlatformRequestError';
  }
}

export async function platformFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(path, { cache: 'no-store', ...init });

  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (!res.ok) {
    const message =
      payload &&
      typeof payload === 'object' &&
      typeof (payload as { error?: unknown }).error === 'string'
        ? (payload as { error: string }).error
        : `HTTP ${res.status}`;
    throw new PlatformRequestError(message, res.status);
  }

  return payload as T;
}

export function platformPost<T>(path: string, body: unknown): Promise<T> {
  return platformFetch<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function platformPatch<T>(path: string, body: unknown): Promise<T> {
  return platformFetch<T>(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function platformPut<T>(path: string, body: unknown): Promise<T> {
  return platformFetch<T>(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Drops empty values so `?q=&status=` never reaches the route. */
export function buildQuery(
  params: Record<string, string | number | null | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}
