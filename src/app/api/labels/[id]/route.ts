import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

/**
 * PATCH  /api/labels/[id]  { name?, description?, color?, position? }  admin
 * DELETE /api/labels/[id]                                            admin —
 *        custom labels only; the RLS policy refuses built-ins and this
 *        route turns that into a clear 400.
 */

const COLUMNS = 'id, key, name, description, color, position, is_builtin'
const COLOR = /^#[0-9a-fA-F]{6}$/

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const patch: Record<string, unknown> = {}
    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!name) return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
      patch.name = name.slice(0, 60)
    }
    if (body.description !== undefined) {
      patch.description = typeof body.description === 'string' ? body.description.trim() || null : null
    }
    if (body.color !== undefined) {
      if (typeof body.color !== 'string' || !COLOR.test(body.color)) {
        return NextResponse.json({ error: 'color must be a #rrggbb value' }, { status: 400 })
      }
      patch.color = body.color
    }
    if (body.position !== undefined) {
      if (typeof body.position !== 'number' || !Number.isInteger(body.position)) {
        return NextResponse.json({ error: 'position must be an integer' }, { status: 400 })
      }
      patch.position = body.position
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }

    const { data, error } = await ctx.supabase
      .from('lead_labels')
      .update(patch)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select(COLUMNS)
      .maybeSingle()
    if (error) {
      console.error('[PATCH /api/labels/[id]] update error:', error)
      return NextResponse.json({ error: 'Failed to update label' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'Label not found' }, { status: 404 })
    return NextResponse.json({ label: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params

    const { data: existing } = await ctx.supabase
      .from('lead_labels')
      .select('id, is_builtin')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (!existing) return NextResponse.json({ error: 'Label not found' }, { status: 404 })
    if (existing.is_builtin) {
      return NextResponse.json(
        { error: 'Built-in labels cannot be deleted — rename them instead' },
        { status: 400 },
      )
    }

    const { error } = await ctx.supabase
      .from('lead_labels')
      .delete()
      .eq('id', id)
      .eq('account_id', ctx.accountId)
    if (error) {
      console.error('[DELETE /api/labels/[id]] delete error:', error)
      return NextResponse.json({ error: 'Failed to delete label' }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
