/**
 * Catalog rules shared by the API routes and the editor.
 *
 * The table is industry-neutral; what makes it useful for one business
 * is its attribute definitions ("nivel", "modalidad", "dormitorios"...)
 * and the validation here that keeps `attributes` honest against them.
 */

export const AVAILABILITY = ['available', 'limited', 'unavailable', 'on_request'] as const
export type Availability = (typeof AVAILABILITY)[number]

export const ATTRIBUTE_TYPES = ['text', 'number', 'boolean', 'select'] as const
export type AttributeType = (typeof ATTRIBUTE_TYPES)[number]

export interface AttributeDefinition {
  id: string
  key: string
  label: string
  type: AttributeType
  options: string[]
  position: number
}

export class CatalogValidationError extends Error {
  readonly code = 'bad_request'
  constructor(message: string) {
    super(message)
    this.name = 'CatalogValidationError'
  }
}

export const ATTRIBUTE_KEY = /^[a-z][a-z0-9_]{0,39}$/

/** Turn a label into a key: "Duración (meses)" → "duracion_meses". */
export function slugifyKey(label: string): string {
  const s = label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
  return /^[a-z]/.test(s) ? s : `a_${s}`.slice(0, 40)
}

/**
 * Coerce and validate an attributes object against the account's
 * definitions. Unknown keys are dropped (the editor only shows defined
 * ones; the assistant only reads defined ones), values are coerced to
 * the declared type, and select values must be one of the options.
 */
export function validateAttributes(
  defs: AttributeDefinition[],
  raw: unknown,
): Record<string, string | number | boolean> {
  const input = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const out: Record<string, string | number | boolean> = {}
  for (const def of defs) {
    const v = input[def.key]
    if (v === undefined || v === null || v === '') continue
    switch (def.type) {
      case 'number': {
        const n = typeof v === 'number' ? v : Number(v)
        if (!Number.isFinite(n)) throw new CatalogValidationError(`${def.label} must be a number`)
        out[def.key] = n
        break
      }
      case 'boolean':
        out[def.key] = v === true || v === 'true' || v === 1 || v === '1'
        break
      case 'select': {
        const s = String(v)
        if (!def.options.includes(s)) {
          throw new CatalogValidationError(`${def.label} must be one of: ${def.options.join(', ')}`)
        }
        out[def.key] = s
        break
      }
      default:
        out[def.key] = String(v).trim().slice(0, 500)
    }
  }
  return out
}

export interface ItemInput {
  name: string
  category: string | null
  description: string | null
  price: number | null
  currency: string | null
  availability: Availability
  stock: number | null
  images: string[]
  variants: unknown[]
  features: string[]
  attributes: Record<string, string | number | boolean>
  status: 'active' | 'archived'
}

/** Validate a create/update body. `partial` allows omitting fields on update. */
export function parseItemBody(
  body: Record<string, unknown>,
  defs: AttributeDefinition[],
  opts: { partial?: boolean; defaultCurrency?: string } = {},
): Partial<ItemInput> {
  const out: Partial<ItemInput> = {}
  const has = (k: string) => body[k] !== undefined

  if (has('name') || !opts.partial) {
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) throw new CatalogValidationError('name is required')
    out.name = name.slice(0, 200)
  }
  if (has('category')) out.category = strOrNull(body.category, 100)
  if (has('description')) out.description = strOrNull(body.description, 4000)
  if (has('price')) {
    if (body.price === null || body.price === '') out.price = null
    else {
      const n = typeof body.price === 'number' ? body.price : Number(body.price)
      if (!Number.isFinite(n) || n < 0) throw new CatalogValidationError('price must be a number >= 0')
      out.price = Math.round(n * 100) / 100
    }
  }
  if (has('currency') || (!opts.partial && opts.defaultCurrency)) {
    const c = typeof body.currency === 'string' ? body.currency.trim().toUpperCase() : ''
    if (c && !/^[A-Z]{3}$/.test(c)) throw new CatalogValidationError('currency must be a 3-letter code')
    out.currency = c || opts.defaultCurrency || null
  }
  if (has('availability') || !opts.partial) {
    const a = body.availability ?? 'available'
    if (!(AVAILABILITY as readonly unknown[]).includes(a)) {
      throw new CatalogValidationError(`availability must be one of ${AVAILABILITY.join(', ')}`)
    }
    out.availability = a as Availability
  }
  if (has('stock')) {
    if (body.stock === null || body.stock === '') out.stock = null
    else {
      const n = typeof body.stock === 'number' ? body.stock : Number(body.stock)
      if (!Number.isInteger(n) || n < 0) throw new CatalogValidationError('stock must be an integer >= 0')
      out.stock = n
    }
  }
  if (has('images')) out.images = strList(body.images, 'images', 2000)
  if (has('features')) out.features = strList(body.features, 'features', 200)
  if (has('variants')) {
    if (!Array.isArray(body.variants)) throw new CatalogValidationError('variants must be an array')
    out.variants = body.variants.slice(0, 50)
  }
  if (has('attributes')) out.attributes = validateAttributes(defs, body.attributes)
  if (has('status')) {
    if (body.status !== 'active' && body.status !== 'archived') {
      throw new CatalogValidationError('status must be active or archived')
    }
    out.status = body.status
  }
  return out
}

function strOrNull(v: unknown, max: number): string | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'string') throw new CatalogValidationError('expected a string')
  const s = v.trim()
  return s ? s.slice(0, max) : null
}

function strList(v: unknown, field: string, max: number): string[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    throw new CatalogValidationError(`${field} must be an array of strings`)
  }
  return (v as string[]).map((s) => s.trim().slice(0, max)).filter(Boolean).slice(0, 50)
}
