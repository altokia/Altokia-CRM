'use client';

// ============================================================
// The plan catalogue, fetched once per page load.
//
// Every screen in the console needs the same three rows: the roster
// prints a plan's name, the provisioning dialog offers the list, the
// commercial card shows what a tier includes. Migration 050 made the
// catalogue a table, so the console reads it instead of hard-coding
// "básico / intermedio / premium" — a tier added in SQL shows up here
// without a deploy.
//
// Cached in a module-level promise rather than a context: it is three
// immutable-ish rows, several unrelated components want them, and a
// provider would force every consumer to sit under one more wrapper.
// A failed fetch clears the cache so the next mount retries.
// ============================================================

import { useEffect, useState } from 'react';

import {
  platformFetch,
  type PlansResponse,
  type PlatformPlan,
} from './platform-api';

let cached: PlatformPlan[] | null = null;
let inflight: Promise<PlatformPlan[]> | null = null;

function byPosition(a: PlatformPlan, b: PlatformPlan): number {
  const pa = typeof a.position === 'number' ? a.position : 0;
  const pb = typeof b.position === 'number' ? b.position : 0;
  return pa === pb ? a.name.localeCompare(b.name) : pa - pb;
}

function loadPlans(): Promise<PlatformPlan[]> {
  if (cached) return Promise.resolve(cached);
  inflight ??= platformFetch<PlansResponse>('/api/platform/plans')
    .then((data) => {
      const plans = [...(data.plans ?? [])].sort(byPosition);
      cached = plans;
      return plans;
    })
    .catch((err) => {
      inflight = null;
      throw err;
    });
  return inflight;
}

export interface PlanCatalogue {
  /** Every plan, active or not — a client may sit on a retired tier. */
  plans: PlatformPlan[];
  /** The tiers an operator may assign today. */
  selectable: PlatformPlan[];
  loading: boolean;
  find: (code: string | null | undefined) => PlatformPlan | null;
}

export function usePlans(): PlanCatalogue {
  // Lazy: a mount that arrives after the catalogue is already in hand
  // renders it immediately, without a second pass through the effect.
  const [plans, setPlans] = useState<PlatformPlan[] | null>(() => cached);

  useEffect(() => {
    if (cached) return;
    let cancelled = false;

    // Resolves after an await, so nothing writes state while the
    // effect body runs.
    const run = async () => {
      try {
        const list = await loadPlans();
        if (!cancelled) setPlans(list);
      } catch (err) {
        console.error('[platform-console] plan catalogue failed:', err);
        if (!cancelled) setPlans([]);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  const list = plans ?? [];

  return {
    plans: list,
    selectable: list.filter((plan) => plan.is_active !== false),
    loading: plans === null,
    find: (code) => (code ? (list.find((p) => p.code === code) ?? null) : null),
  };
}

/**
 * The name to print for a plan code. Falls back to the raw code so a
 * tier the catalogue has not loaded (or one deleted out from under an
 * account) still reads as something rather than vanishing.
 */
export function planLabel(
  plans: PlatformPlan[],
  code: string | null | undefined,
): string | null {
  if (!code) return null;
  return plans.find((p) => p.code === code)?.name ?? code;
}
