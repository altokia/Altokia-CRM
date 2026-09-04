// ============================================================
// Server-side account context — for API routes and server
// components. Reads the caller's profile + account in one round
// trip and verifies role on demand.
//
// IMPORTANT: this module is server-only. It imports the Supabase
// SSR client (`@/lib/supabase/server`), which reads `next/headers`
// cookies. Importing it from a client component will fail at
// build time with the standard Next.js "You're importing a
// component that needs `next/headers`" error — that's the
// boundary check; we don't need the `server-only` package.
//
// Calling convention
// ------------------
// API routes don't need to redo `supabase.auth.getUser()` — they
// receive a fully-loaded context from `requireRole`:
//
//   try {
//     const ctx = await requireRole("admin");
//     // ctx.supabase — the SSR client (RLS scoped to this user)
//     // ctx.userId  — auth.uid()
//     // ctx.accountId / ctx.role / ctx.account
//   } catch (err) {
//     return errorResponse(err); // see toErrorResponse() below
//   }
// ============================================================

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import { hasMinRole, isAccountRole, type AccountRole } from "./roles";

// ------------------------------------------------------------
// Errors
//
// Custom classes so API routes can map a single `catch` to the
// right HTTP status without sprinkling 401/403 strings everywhere.
// ------------------------------------------------------------

export class UnauthorizedError extends Error {
  readonly status = 401 as const;
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends Error {
  readonly status = 403 as const;
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/**
 * Convert one of the typed errors above (or anything else) into a
 * `NextResponse`. Routes can do:
 *
 *   } catch (err) {
 *     return toErrorResponse(err);
 *   }
 *
 * Unknown errors collapse to 500 with the generic message — we
 * never leak `err.message` for non-classified errors to keep
 * server internals out of the wire.
 */
export function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error("[toErrorResponse] uncategorized error:", err);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}

// ------------------------------------------------------------
// Account context
// ------------------------------------------------------------

export interface AccountContext {
  /** Supabase SSR client, RLS scoped to the calling user. */
  supabase: SupabaseClient;
  /** `auth.uid()` for the caller. Always defined when this resolves. */
  userId: string;
  /** Caller's account_id from their profile row. */
  accountId: string;
  /** Caller's role within their account. */
  role: AccountRole;
  /**
   * Lightweight account meta. `status` arrives with migration 045 and
   * is the tenant's standing with Altokia — a suspended customer keeps
   * full read access to their own data (they have to be able to see
   * what they are paying for, and to fix whatever caused it) but may
   * not send. Enforce it with `assertAccountActive`, never by hiding
   * the data.
   *
   * `accessRevokedAt` (050) is the other axis entirely: not "what may
   * this customer do", but "may these people get in at all". See
   * `assertAccountAccess`.
   */
  account: {
    id: string;
    name: string;
    status: AccountStatus;
    /** ISO timestamp, or null when access is intact. */
    accessRevokedAt: string | null;
  };
}

export const ACCOUNT_STATUSES = ['trial', 'active', 'suspended', 'cancelled'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

function isAccountStatus(value: unknown): value is AccountStatus {
  return (
    typeof value === "string" &&
    (ACCOUNT_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * True for the two ways PostgREST reports "you selected a column that
 * does not exist": Postgres' own 42703, and PGRST204 from the schema
 * cache. Narrow on purpose — any other failure must stay fatal.
 */
function isMissingColumnError(err: { code?: string } | null): boolean {
  return err?.code === "42703" || err?.code === "PGRST204";
}

/**
 * Refuse an action that costs the customer money or reaches the outside
 * world when the account is not in good standing.
 *
 * Called by the send paths, not by reads. The message names the state
 * on purpose: "contact Altokia" with no reason is how a support ticket
 * becomes a phone call.
 */
export function assertAccountActive(ctx: AccountContext): void {
  const status = ctx.account.status;
  if (status === "active" || status === "trial") return;
  throw new ForbiddenError(
    status === "suspended"
      ? "This account is suspended. Sending is disabled until it is reactivated."
      : "This account is cancelled. Sending is disabled.",
  );
}

/**
 * Refuse *everything* when Altokia has pulled this client's access.
 *
 * How this differs from `assertAccountActive`, because the two look
 * alike and are not:
 *
 *   suspended (status)      — commercial. The customer still reads
 *                             their own inbox, contacts and history;
 *                             they just cannot send. Losing sight of
 *                             their own data over an unpaid invoice
 *                             would be punitive and unhelpful.
 *   revoked (access_revoked_at) — nobody from that company signs in.
 *                             The data is untouched and comes straight
 *                             back when access is restored, but while
 *                             it is revoked there is no reading either.
 *
 * The real enforcement is the ban on the auth users themselves (050),
 * applied by the platform console, so a revoked user never gets a
 * session to reach this code with. This is the second barrier: it
 * catches a session minted moments before the ban, and any path where
 * the auth-side ban did not land — a partial failure in the console, an
 * extra member added after the revocation, a service that authenticates
 * some other way. Call it wherever a request would otherwise act on
 * account data, alongside (not instead of) the role check.
 */
export function assertAccountAccess(ctx: AccountContext): void {
  if (!ctx.account.accessRevokedAt) return;
  throw new ForbiddenError(
    "Access to this account has been withdrawn. Contact Altokia to restore it.",
  );
}

/**
 * Resolve the caller's user + account + role in one round trip.
 *
 * Throws `UnauthorizedError` if there's no Supabase session.
 * Throws `ForbiddenError` if the profile is missing account
 * fields (shouldn't happen post-017 migration; defensive guard
 * against profile rows that pre-date the backfill or were
 * inserted by hand).
 *
 * Use `requireRole(min)` instead when the route also needs a
 * minimum-role check — it's a thin wrapper over this.
 */
export async function getCurrentAccount(): Promise<AccountContext> {
  const supabase = await createClient();

  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    throw new UnauthorizedError();
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("account_id, account_role")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    console.error("[getCurrentAccount] profile fetch error:", error);
    throw new ForbiddenError("Could not load account context");
  }
  if (!data || !data.account_id || !data.account_role) {
    // Pre-migration profile, or a manual insert that skipped the
    // signup trigger. The user is authenticated but the app has
    // no way to scope their queries — treat as forbidden.
    throw new ForbiddenError("Profile is not linked to an account");
  }
  if (!isAccountRole(data.account_role)) {
    // The DB enum should make this impossible, but a future
    // migration that broadens the enum without updating TS would
    // hit this — surface it rather than silently widening.
    throw new ForbiddenError(`Unknown account role: ${data.account_role}`);
  }

  // Load the account with a plain point lookup by id rather than an
  // embedded FK join (`account:accounts!inner(...)`). The embed forces
  // PostgREST to resolve the profiles.account_id → accounts.id
  // relationship from its schema cache; when that cache is stale — a
  // common Supabase state right after a migration adds the FK, or when
  // migrations are applied out of band — the embed fails hard with
  // PGRST200 ("could not find a relationship … in the schema cache")
  // and takes down the entire account context (issue #294). A lookup by
  // id needs no relationship inference and is gated by the same accounts
  // RLS, so it stays robust against cache staleness and older schemas.
  let { data: account, error: accountErr } = await supabase
    .from("accounts")
    .select("id, name, status, access_revoked_at")
    .eq("id", data.account_id)
    .maybeSingle();

  // `access_revoked_at` arrives with migration 050. A deployment whose
  // code is ahead of its database would get PGRST204/42703 here and, via
  // the throw below, lock every user of every account out of the entire
  // app over a column that only ever adds a restriction. Retry once
  // without it; a missing column simply means nobody is revoked yet.
  if (accountErr && isMissingColumnError(accountErr)) {
    console.warn(
      "[getCurrentAccount] accounts.access_revoked_at missing — is migration 050 applied?",
    );
    ({ data: account, error: accountErr } = await supabase
      .from("accounts")
      .select("id, name, status")
      .eq("id", data.account_id)
      .maybeSingle());
  }

  if (accountErr) {
    console.error("[getCurrentAccount] account fetch error:", accountErr);
    throw new ForbiddenError("Could not load account context");
  }
  if (!account) {
    // account_id points at no readable account row — orphaned profile
    // or an RLS gap. Same "can't scope this user" outcome as above.
    throw new ForbiddenError("Profile is not linked to an account");
  }

  // The gate lives here, not in each route. `assertAccountAccess` was
  // available and called from exactly one of the fifty-six authenticated
  // routes, which meant a session opened moments before the revocation
  // kept working everywhere else until its token expired. Every route
  // that resolves an account passes through this function, so refusing
  // here is the only placement that cannot be forgotten.
  //
  // Deliberately not the same as a suspended account: suspension still
  // reads (see assertAccountActive). A revoked one does not get in.
  if (typeof account.access_revoked_at === "string" && account.access_revoked_at) {
    throw new ForbiddenError(
      "Access to this account has been withdrawn. Contact Altokia to restore it.",
    );
  }

  return {
    supabase,
    userId: user.id,
    accountId: data.account_id,
    role: data.account_role,
    // A row written before 045, or an enum widened without updating
    // this file, must not lock a paying customer out of sending —
    // default to active and let the platform console be the authority.
    account: {
      id: account.id,
      name: account.name,
      status: isAccountStatus(account.status) ? account.status : "active",
      // Absent on a pre-050 database (see the retry above), where the
      // honest answer is "nobody has been revoked".
      accessRevokedAt:
        typeof account.access_revoked_at === "string"
          ? account.access_revoked_at
          : null,
    },
  };
}

/**
 * Resolve the caller's account context and enforce a minimum role.
 *
 * Throws `UnauthorizedError` / `ForbiddenError` as documented on
 * `getCurrentAccount`, plus `ForbiddenError("Insufficient role")`
 * when the caller is below `min`.
 */
export async function requireRole(min: AccountRole): Promise<AccountContext> {
  const ctx = await getCurrentAccount();
  if (!hasMinRole(ctx.role, min)) {
    throw new ForbiddenError(
      `This action requires the '${min}' role or higher`,
    );
  }
  return ctx;
}
