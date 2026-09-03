import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { CatalogValidationError, parseItemBody } from '@/lib/catalog'
import { loadDefinitions } from '../route'

/**
 * PATCH  /api/catalog/[id]  — partial update (admin)
 * DELETE /api/catalog/[id]  — archives rather than deletes (admin): the
 *        assistant stops offering it, but conversation_insights rows
 *        that point at it keep their history.
 */

const ITEM_COLUMNS =
  'id, name, category, description, price, currency, availability, stock, images, variants, features, attributes, status, created_at, updated_at'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('admin')
    const { id } = await params
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const defs = await loadDefinitions(ctx.supabase, ctx.accountId)
    let patch
    try {
      patch = parseItemBody(body, defs, { partial: true })
    } catch (err) {
      if (err instanceof CatalogValidationError) return NextResponse.json({ error: err.message }, { status: 400 })
      throw err
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }

    const { data, error } = await ctx.supabase
      .from('catalog_items')
      .update(patch)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select(ITEM_COLUMNS)
      .maybeSingle()
    if (error) {
      console.error('[PATCH /api/catalog/[id]] update error:', error)
      return NextResponse.json({ error: 'Failed to update item' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'Item not found' }, { status: 404 })
    return NextResponse.json({ item: data })
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
    const { data, error } = await ctx.supabase
      .from('catalog_items')
      .update({ status: 'archived' })
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select('id')
      .maybeSingle()
    if (error) {
      console.error('[DELETE /api/catalog/[id]] archive error:', error)
      return NextResponse.json({ error: 'Failed to archive item' }, { status: 500 })
    }
    if (!data) return NextResponse.json({ error: 'Item not found' }, { status: 404 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
