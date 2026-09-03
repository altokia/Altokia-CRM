import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { ATTRIBUTE_KEY, ATTRIBUTE_TYPES, slugifyKey } from '@/lib/catalog'

/**
 * /api/catalog/attributes — the business's attribute vocabulary.
 *
 *   GET                                   any member
 *   PUT { definitions: [{ key?, label, type, options? }] }   admin —
 *       replaces the whole list (order = position). Removing a
 *       definition does not touch existing items; their extra keys are
 *       simply no longer shown or validated.
 */

export async function GET() {
  try {
    const ctx = await getCurrentAccount()
    const { data, error } = await ctx.supabase
      .from('catalog_attribute_definitions')
      .select('id, key, label, type, options, position')
      .eq('account_id', ctx.accountId)
      .order('position', { ascending: true })
    if (error) {
      console.error('[GET /api/catalog/attributes] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load attributes' }, { status: 500 })
    }
    return NextResponse.json({ definitions: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const body = (await request.json().catch(() => null)) as { definitions?: unknown } | null
    if (!body || !Array.isArray(body.definitions)) {
      return NextResponse.json({ error: 'definitions must be an array' }, { status: 400 })
    }

    const seen = new Set<string>()
    const rows: Array<{ key: string; label: string; type: string; options: string[]; position: number }> = []
    for (const [i, raw] of (body.definitions as unknown[]).entries()) {
      if (!raw || typeof raw !== 'object') {
        return NextResponse.json({ error: `definitions[${i}] must be an object` }, { status: 400 })
      }
      const d = raw as Record<string, unknown>
      const label = typeof d.label === 'string' ? d.label.trim() : ''
      if (!label) return NextResponse.json({ error: `definitions[${i}].label is required` }, { status: 400 })
      const key = typeof d.key === 'string' && d.key.trim() ? d.key.trim() : slugifyKey(label)
      if (!ATTRIBUTE_KEY.test(key)) {
        return NextResponse.json({ error: `definitions[${i}].key must match ${ATTRIBUTE_KEY}` }, { status: 400 })
      }
      if (seen.has(key)) return NextResponse.json({ error: `duplicate key "${key}"` }, { status: 400 })
      seen.add(key)
      const type = (ATTRIBUTE_TYPES as readonly unknown[]).includes(d.type) ? (d.type as string) : 'text'
      const options =
        type === 'select' && Array.isArray(d.options)
          ? (d.options as unknown[]).map((o) => String(o).trim()).filter(Boolean)
          : []
      if (type === 'select' && options.length === 0) {
        return NextResponse.json({ error: `definitions[${i}] of type select needs options` }, { status: 400 })
      }
      rows.push({ key, label: label.slice(0, 100), type, options, position: i })
    }

    // Replace the list wholesale: dozens of rows at most, and a diff
    // would only add ways to leave stale definitions behind.
    const { error: delError } = await ctx.supabase
      .from('catalog_attribute_definitions')
      .delete()
      .eq('account_id', ctx.accountId)
    if (delError) {
      console.error('[PUT /api/catalog/attributes] delete error:', delError)
      return NextResponse.json({ error: 'Failed to save attributes' }, { status: 500 })
    }
    if (rows.length) {
      const { error: insError } = await ctx.supabase
        .from('catalog_attribute_definitions')
        .insert(rows.map((r) => ({ account_id: ctx.accountId, ...r })))
      if (insError) {
        console.error('[PUT /api/catalog/attributes] insert error:', insError)
        return NextResponse.json({ error: 'Failed to save attributes' }, { status: 500 })
      }
    }

    const { data } = await ctx.supabase
      .from('catalog_attribute_definitions')
      .select('id, key, label, type, options, position')
      .eq('account_id', ctx.accountId)
      .order('position', { ascending: true })
    return NextResponse.json({ definitions: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}
