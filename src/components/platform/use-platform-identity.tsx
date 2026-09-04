'use client';

// ============================================================
// Who is looking at the console?
//
// The CRM's AuthProvider is the wrong tool here: it resolves the
// *account membership* of a login, and a platform operator is
// deliberately a member of no account (045 keeps the two planes
// disjoint). So the console asks its own question instead.
//
// One request answers both halves of it. `/api/platform/operators`
// begins with requirePlatformOperator(), whose failure modes are
// distinguishable on purpose:
//
//   404 → not staff at all. The access layer refuses to confirm the
//         console exists, so this is the console's "denied" screen.
//   403 → staff, but the route wanted a higher role. Still an
//         operator; just not the owner.
//   200 → staff, and the roster comes back with it, so the caller's
//         own row gives their exact role.
//
// A transport failure is NOT treated as denial: the pages behind this
// gate each surface their own errors, and locking a working operator
// out of the console over one flaky request would be worse.
// ============================================================

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { createClient } from '@/lib/supabase/client';
import {
  isPlatformRole,
  type OperatorsResponse,
  type PlatformRole,
} from './platform-api';

export type PlatformIdentity =
  | { state: 'loading' }
  /** Proven not to be an operator — render the console's refusal. */
  | { state: 'denied' }
  /** An operator. `role` is null when the roster could not be read. */
  | { state: 'ready'; role: PlatformRole | null; userId: string | null };

const PlatformIdentityContext = createContext<PlatformIdentity>({
  state: 'loading',
});

/** Read the identity the shell already resolved. */
export function usePlatformIdentity(): PlatformIdentity {
  return useContext(PlatformIdentityContext);
}

/** True only when we positively know the caller is a platform owner. */
export function useIsPlatformOwner(): boolean {
  const identity = usePlatformIdentity();
  return identity.state === 'ready' && identity.role === 'owner';
}

/**
 * Resolves the identity once. Used by the shell only; every other
 * component reads the result through `usePlatformIdentity`.
 */
export function usePlatformIdentityValue(): PlatformIdentity {
  const [identity, setIdentity] = useState<PlatformIdentity>({
    state: 'loading',
  });

  useEffect(() => {
    let cancelled = false;

    // Every setIdentity below sits after an await, so nothing writes
    // state synchronously while the effect runs.
    const resolve = async () => {
      let userId: string | null = null;
      try {
        const supabase = createClient();
        const {
          data: { user },
        } = await supabase.auth.getUser();
        userId = user?.id ?? null;
      } catch (err) {
        console.error('[platform-console] session lookup failed:', err);
      }

      try {
        const res = await fetch('/api/platform/operators', {
          cache: 'no-store',
        });

        if (res.status === 404 || res.status === 401) {
          if (!cancelled) setIdentity({ state: 'denied' });
          return;
        }

        if (res.status === 403) {
          // An operator whose role is below whatever the roster route
          // demands. Enough to use the console; not the owner.
          if (!cancelled) setIdentity({ state: 'ready', role: null, userId });
          return;
        }

        if (!res.ok) {
          if (!cancelled) setIdentity({ state: 'ready', role: null, userId });
          return;
        }

        const payload = (await res.json()) as OperatorsResponse;
        const mine = userId
          ? payload.operators?.find((o) => o.user_id === userId)
          : undefined;

        const role = mine && isPlatformRole(mine.role) ? mine.role : null;

        if (!cancelled) setIdentity({ state: 'ready', role, userId });
      } catch (err) {
        console.error('[platform-console] identity lookup failed:', err);
        if (!cancelled) setIdentity({ state: 'ready', role: null, userId });
      }
    };

    void resolve();
    return () => {
      cancelled = true;
    };
  }, []);

  return identity;
}

export function PlatformIdentityProvider({
  identity,
  children,
}: {
  identity: PlatformIdentity;
  children: ReactNode;
}) {
  const value = useMemo(() => identity, [identity]);
  return (
    <PlatformIdentityContext.Provider value={value}>
      {children}
    </PlatformIdentityContext.Provider>
  );
}
