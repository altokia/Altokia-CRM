/**
 * Catalog tools — what the assistant may look up, and nothing else.
 *
 * The assistant never sees the catalog table; it sees two functions
 * with tight inputs and compact outputs. Prices and availability come
 * back from these calls verbatim, which is what makes "never invent a
 * price" enforceable rather than a hope in the prompt.
 *
 * Search is lexical (the `fts` column, 'simple' config, any language)
 * with an ILIKE fallback for very short or misspelt queries. Good
 * enough for a catalog of hundreds; a semantic index can be added later
 * without changing the tool contract.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface CatalogToolItem {
  id: string
  name: string
  category: string | null
  price: number | null
  currency: string | null
  availability: string
  stock: number | null
  description?: string | null
  attributes: Record<string, unknown>
  variants?: unknown[]
  features?: string[]
}

const SEARCH_COLUMNS =
  'id, name, category, price, currency, availability, stock, attributes'
const ITEM_COLUMNS =
  'id, name, category, description, price, currency, availability, stock, attributes, variants, features'

export const SEARCH_ITEMS_TOOL = {
  name: 'search_items',
  description:
    "Search the business's products and services by words the customer used (name, category, feature, attribute). Returns up to 5 matches with price and availability. Call it before answering any question about prices, availability, options or what the business offers.",
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      query: { type: 'string', description: 'Words from the customer message, in their language.' },
      category: { type: ['string', 'null'], description: 'Optional category to narrow the search.' },
    },
    required: ['query'],
  },
} as const

export const GET_ITEM_TOOL = {
  name: 'get_item',
  description:
    'Get the full details of one product or service by the id returned from search_items: description, price, availability, variants, features and attributes.',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
} as const

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

export async function searchItems(
  db: SupabaseClient,
  accountId: string,
  input: { query?: unknown; category?: unknown },
): Promise<CatalogToolItem[]> {
  const query = typeof input.query === 'string' ? input.query.trim() : ''
  const category = typeof input.category === 'string' ? input.category.trim() : ''
  if (!query) return []

  // websearch_to_tsquery is forgiving with free text ("curso de inglés
  // para niños"); 'simple' matches the generated column's config.
  let q = db
    .from('catalog_items')
    .select(SEARCH_COLUMNS)
    .eq('account_id', accountId)
    .eq('status', 'active')
    .textSearch('fts', query, { type: 'websearch', config: 'simple' })
    .limit(5)
  if (category) q = q.ilike('category', `%${category}%`)
  const { data, error } = await q

  let rows = (error ? [] : data) ?? []
  if (rows.length === 0) {
    // Fallback: substring match on the name for short/misspelt queries.
    const term = query.split(/\s+/).sort((a, b) => b.length - a.length)[0] ?? query
    let f = db
      .from('catalog_items')
      .select(SEARCH_COLUMNS)
      .eq('account_id', accountId)
      .eq('status', 'active')
      .ilike('name', `%${term}%`)
      .limit(5)
    if (category) f = f.ilike('category', `%${category}%`)
    const { data: fb } = await f
    rows = fb ?? []
  }

  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    category: (r.category as string | null) ?? null,
    price: toNumber(r.price),
    currency: (r.currency as string | null) ?? null,
    availability: r.availability as string,
    stock: toNumber(r.stock),
    attributes: (r.attributes as Record<string, unknown>) ?? {},
  }))
}

export async function getItem(
  db: SupabaseClient,
  accountId: string,
  input: { id?: unknown },
): Promise<CatalogToolItem | null> {
  const id = typeof input.id === 'string' ? input.id : ''
  if (!id) return null
  const { data } = await db
    .from('catalog_items')
    .select(ITEM_COLUMNS)
    .eq('account_id', accountId)
    .eq('id', id)
    .maybeSingle()
  if (!data) return null
  return {
    id: data.id as string,
    name: data.name as string,
    category: (data.category as string | null) ?? null,
    description: (data.description as string | null) ?? null,
    price: toNumber(data.price),
    currency: (data.currency as string | null) ?? null,
    availability: data.availability as string,
    stock: toNumber(data.stock),
    attributes: (data.attributes as Record<string, unknown>) ?? {},
    variants: (data.variants as unknown[]) ?? [],
    features: (data.features as string[]) ?? [],
  }
}

/**
 * Dispatch one tool call by name. Unknown tools return an error object
 * the model can read instead of throwing — a wrong tool name is the
 * model's mistake, not a reason to drop the customer's message.
 */
export async function runCatalogTool(
  db: SupabaseClient,
  accountId: string,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case SEARCH_ITEMS_TOOL.name: {
      const items = await searchItems(db, accountId, input)
      return items.length ? { items } : { items: [], note: 'No matching product or service. Do not invent one; say you do not have that information or ask what they mean.' }
    }
    case GET_ITEM_TOOL.name: {
      const item = await getItem(db, accountId, input)
      return item ?? { error: 'No item with that id.' }
    }
    default:
      return { error: `Unknown tool ${name}` }
  }
}
