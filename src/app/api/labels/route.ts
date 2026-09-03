import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { ATTRIBUTE_KEY, slugifyKey } from '@/lib/catalog'

/**
 * /api/labels — lead labels.
 *
 *   GET                                      any member
 *   POST { name, description?, color? }      admin — a custom label; the
 *        key is derived from the name and never changes afterwards.
 *
 * Built-in labels (seeded by migration 042) can be renamed and recoloured
 * through PATCH /api/labels/[id] but not deleted — code and the
 * assistant's schema refer to their keys.
 */

const COLUMNS = 'id, key, name, description, color, position, is_builtin'
const COLOR = /^#[0-9a-fA-F]{6}$/

export async function GET() {
  try {
    const ctx = await getCurrentAccount()
    const { data, error } = await ctx.supabase
      .from('lead_labels')
      .select(COLUMNS)
      .eq('account_id', ctx.accountId)
      .order('position', { ascending: true })
    if (error) {
      console.error('[GET /api/labels] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load labels' }, { status: 500 })
    }
    return NextResponse.json({ labels: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 })
    const description = typeof body.description === 'string' ? body.description.trim() || null : null
    const color = typeof body.color === 'string' && COLOR.test(body.color) ? body.color : '#64748b'

    let key = slugifyKey(name)
    if (!ATTRIBUTE_KEY.test(key)) key = `label_${Date.now().toString(36)}`

    const { data: last } = await ctx.supabase
      .from('lead_labels')
      .select('position')
      .eq('account_id', ctx.accountId)
      .order('position', { ascending: false })
      .limit(1)
      .maybeSingle()

    const { data, error } = await ctx.supabase
      .from('lead_labels')
      .insert({
        account_id: ctx.accountId,
        key,
        name: name.slice(0, 60),
        description,
        color,
        position: ((last?.position as number | undefined) ?? 0) + 1,
        is_builtin: false,
      })
      .select(COLUMNS)
      .single()
    if (error) {
      if (error.code === '23505') {
        return NextResponse.json({ error: 'A label with that name already exists' }, { status: 409 })
      }
      console.error('[POST /api/labels] insert error:', error)
      return NextResponse.json({ error: 'Failed to create label' }, { status: 500 })
    }
    return NextResponse.json({ label: data }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
