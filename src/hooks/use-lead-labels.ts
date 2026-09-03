'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

export interface LeadLabelLite {
  key: string;
  name: string;
  color: string;
  position: number;
}

// One fetch per page load, shared by every card on the board and the
// deal form. `loadLeadLabels(true)` refreshes after the labels manager
// saves a change.
let cache: LeadLabelLite[] | null = null;
let inflight: Promise<LeadLabelLite[]> | null = null;

export function loadLeadLabels(force = false): Promise<LeadLabelLite[]> {
  if (cache && !force) return Promise.resolve(cache);
  if (inflight) return inflight;
  const request = (async () => {
    const { data } = await createClient()
      .from('lead_labels')
      .select('key, name, color, position')
      .order('position', { ascending: true });
    cache = (data ?? []) as LeadLabelLite[];
    inflight = null;
    return cache;
  })();
  inflight = request;
  return request;
}

/** The account's lead labels, in display order. Empty until loaded. */
export function useLeadLabels(): LeadLabelLite[] {
  const [labels, setLabels] = useState<LeadLabelLite[]>(cache ?? []);
  useEffect(() => {
    let alive = true;
    loadLeadLabels().then((l) => {
      if (alive) setLabels(l);
    });
    return () => {
      alive = false;
    };
  }, []);
  return labels;
}
