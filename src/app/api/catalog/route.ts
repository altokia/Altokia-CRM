import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  CatalogValidationError,
  parseItemBody,
  type AttributeDefinition,
} from '@/lib/catalog'

/**
 * /api/catalog — products and services.
 *
 *   GET  ?q=&status=active|archived|all   any member
 *   POST { name, category?, description?, price?, currency?, availability?,
 *          stock?, images?, variants?, features?, attributes? }   admin
 *
 * Attributes are validated against the account's definitions (see
 * /api/catalog/attributes), so a typo'd key never lands in the row and
 * the assistant only ever sees the vocabulary the business defined.
 */

const ITEM_COLUMNS =
  'id, name, category, description, price, currency, availability, stock, images, variants, features, attributes, status, created_at, updated_at'

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const url = new URL(request.url)
    const q = url.searchParams.get('q')?.trim() ?? ''
    const status = url.searchParams.get('status') ?? 'active'

    let query = ctx.supabase.from('catalog_items').select(ITEM_COLUMNS).eq('account_id', ctx.accountId)
    if (status === 'active' || status === 'archived') query = query.eq('status', status)
    if (q) query = query.or(`name.ilike.%${q}%,category.ilike.%${q}%,description.ilike.%${q}%`)
    const { data, error } = await query.order('name', { ascending: true }).limit(500)
    if (error) {
      console.error('[GET /api/catalog] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load catalog' }, { status: 500 })
    }
    return NextResponse.json({ items: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const [defs, account] = await Promise.all([
      loadDefinitions(ctx.supabase, ctx.accountId),
      ctx.supabase.from('accounts').select('default_currency').eq('id', ctx.accountId).maybeSingle(),
    ])

    let input
    try {
      input = parseItemBody(body, defs, {
        defaultCurrency: (account.data?.default_currency as string | undefined) ?? undefined,
      })
    } catch (err) {
      if (err instanceof CatalogValidationError) return NextResponse.json({ error: err.message }, { status: 400 })
      throw err
    }

    const { data, error } = await ctx.supabase
      .from('catalog_items')
      .insert({ account_id: ctx.accountId, ...input })
      .select(ITEM_COLUMNS)
      .single()
    if (error) {
      console.error('[POST /api/catalog] insert error:', error)
      return NextResponse.json({ error: 'Failed to create item' }, { status: 500 })
    }
    return NextResponse.json({ item: data }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function loadDefinitions(
  db: Awaited<ReturnType<typeof getCurrentAccount>>['supabase'],
  accountId: string,
): Promise<AttributeDefinition[]> {
  const { data } = await db
    .from('catalog_attribute_definitions')
    .select('id, key, label, type, options, position')
    .eq('account_id', accountId)
    .order('position', { ascending: true })
  return ((data ?? []) as Array<Omit<AttributeDefinition, 'options'> & { options: unknown }>).map((d) => ({
    ...d,
    options: Array.isArray(d.options) ? (d.options as unknown[]).map(String) : [],
  }))
}
