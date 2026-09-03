/**
 * Lead labels — the business's commercial vocabulary for a contact.
 *
 * Keys are stable and code refers to them; names are whatever the
 * business wants to call them (defaults seeded in migration 042 in
 * casual Peruvian Spanish). The assistant classifies into keys; the UI
 * shows names.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { LeadLabelOption } from './structured'

export interface LeadLabel extends LeadLabelOption {
  id: string
  color: string
  position: number
  is_builtin: boolean
}

export async function loadLeadLabels(db: SupabaseClient, accountId: string): Promise<LeadLabel[]> {
  const { data, error } = await db
    .from('lead_labels')
    .select('id, key, name, description, color, position, is_builtin')
    .eq('account_id', accountId)
    .order('position', { ascending: true })
  if (error) {
    console.warn('[ai labels] load failed:', error.message)
    return []
  }
  return (data ?? []) as LeadLabel[]
}
