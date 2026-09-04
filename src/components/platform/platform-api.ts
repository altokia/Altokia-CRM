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
  plan: string | null;
  created_at: string;
  provisioned_at: string | null;
  whatsapp: { connected: boolean; display_phone_number: string | null } | null;
  people: number | null;
  last_activity_at: string | null;
}

export interface AccountListResponse {
  accounts: AccountListRow[];
  next_cursor?: string | null;
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
  access: AccountAccess;
  whatsapp?: AccountWhatsapp | null;
}

export interface WhatsappSaveResponse {
  webhook_url: string;
  verify_token: string;
}

export interface AccessRequestResponse {
  status: AccessStatus;
}

export interface CreateAccountResponse {
  account_id: string;
  invite_url: string;
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
