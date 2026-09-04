// ============================================================
// /api/platform/plans — the price list.
//
//   GET   — the catalogue, in display order. Any operator.
//   PATCH — edit one tier: its name, its blurb, what it includes.
//           'billing' only, and audited.
//
// Before 050 a plan was free text on `accounts.plan`, which meant
// "Premium", "premium" and "premiun" were three different plans and
// nothing in the software could say what any of them included. Now the
// column is a foreign key into `platform_plans`, so this route is the
// only way the set of sellable tiers changes, and every account already
// on a plan follows the edit automatically — that is the entire point
// of a reference rather than a copy.
//
// There is no POST and no DELETE, deliberately. Creating a tier means
// deciding what happens to its limits, its position in the list and the
// accounts that will point at it; removing one means deciding what
// happens to the customers on it (`ON DELETE SET NULL`, which is to say
// "on no plan at all"). Both are migrations, taken on purpose, not
// buttons in a console.
// ============================================================

import { NextResponse } from 'next/server'

import {
  logPlatformAction,
  requirePlatformOperator,
  toPlatformErrorResponse,
} from '@/lib/platform'

const PLAN_SELECT =
  'code, name, description, limits, price_note, position, is_active, created_at, updated_at'

const MAX_CODE_LEN = 32
const MAX_NAME_LEN = 120
const MAX_DESCRIPTION_LEN = 1000
const MAX_PRICE_NOTE_LEN = 120
const MAX_LIMIT_KEYS = 40

/** 050's own CHECK on `platform_plans.limits`: a key names a ceiling. */
const LIMIT_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

// ------------------------------------------------------------
// GET
// ------------------------------------------------------------
/**
 * GET /api/platform/plans?active_only=true
 *
 * Ordered by `position`, then `code` so the list is stable when two
 * tiers share a position — a list that reshuffles between renders is a
 * list an operator stops trusting.
 *
 * Retired plans are included by default: an account can still be on
 * one, and a console that hid it would show that customer as having no
 * plan at all. `active_only=true` is for the pickers that must only
 * offer what is currently sold.
 */
export async function GET(request: Request) {
  try {
    const ctx = await requirePlatformOperator()

    const url = new URL(request.url)
    const activeOnly = url.searchParams.get('active_only') === 'true'

    let query = ctx.db
      .from('platform_plans')
      .select(PLAN_SELECT)
      .order('position', { ascending: true })
      .order('code', { ascending: true })

    if (activeOnly) query = query.eq('is_active', true)

    const { data, error } = await query
    if (error) {
      console.error('[GET /api/platform/plans] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load the plans' }, { status: 500 })
    }

    return NextResponse.json({ plans: data ?? [] })
  } catch (err) {
    return toPlatformErrorResponse(err)
  }
}

// ------------------------------------------------------------
// PATCH
// ------------------------------------------------------------
/**
 * PATCH /api/platform/plans
 *
 * Body: { code, name?, description?, limits?, price_note?, is_active? }
 *
 * ─── Why `limits` is validated key by key ─────────────────────────
 * The column is JSONB with only `jsonb_typeof(limits) = 'object'` behind
 * it, so Postgres would happily store `{"seats": "muchos"}` or
 * `{"seats": -1}`. Whatever reads a limit later has to answer "is this
 * account over its ceiling", and the honest answer to that question over
 * a string is a crash. Integers, zero or above, are the only shape that
 * means anything — and an ABSENT key keeps meaning "no ceiling", which
 * is why null is refused too: the way to remove a limit is to leave the
 * key out of the object, not to set it to nothing.
 *
 * `limits` REPLACES the stored object rather than merging into it. A
 * merge could never delete a ceiling, and an editor that cannot remove
 * a row is an editor that grows garbage.
 */
export async function PATCH(request: Request) {
  try {
    // Editing the price list is a commercial act, and it reaches every
    // account already pointing at the tier.
    const ctx = await requirePlatformOperator('billing')

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const code = typeof body.code === 'string' ? body.code.trim() : ''
    if (!code || code.length > MAX_CODE_LEN) {
      return NextResponse.json(
        { error: 'code is required and must name an existing plan' },
        { status: 400 }
      )
    }

    const patch: Record<string, unknown> = {}

    // --- name ---------------------------------------------------
    if (body.name !== undefined) {
      if (
        typeof body.name !== 'string' ||
        !body.name.trim() ||
        body.name.trim().length > MAX_NAME_LEN
      ) {
        return NextResponse.json(
          { error: `name must be a non-empty string of ${MAX_NAME_LEN} characters or fewer` },
          { status: 400 }
        )
      }
      patch.name = body.name.trim()
    }

    // --- description --------------------------------------------
    if (body.description !== undefined) {
      if (body.description === null) {
        patch.description = null
      } else if (
        typeof body.description !== 'string' ||
        body.description.length > MAX_DESCRIPTION_LEN
      ) {
        return NextResponse.json(
          {
            error: `description must be a string of ${MAX_DESCRIPTION_LEN} characters or fewer, or null`,
          },
          { status: 400 }
        )
      } else {
        patch.description = body.description.trim() || null
      }
    }

    // --- price_note ---------------------------------------------
    if (body.price_note !== undefined) {
      if (body.price_note === null) {
        patch.price_note = null
      } else if (
        typeof body.price_note !== 'string' ||
        body.price_note.length > MAX_PRICE_NOTE_LEN
      ) {
        return NextResponse.json(
          {
            error: `price_note must be a string of ${MAX_PRICE_NOTE_LEN} characters or fewer, or null`,
          },
          { status: 400 }
        )
      } else {
        patch.price_note = body.price_note.trim() || null
      }
    }

    // --- is_active ----------------------------------------------
    if (body.is_active !== undefined) {
      if (typeof body.is_active !== 'boolean') {
        return NextResponse.json({ error: 'is_active must be true or false' }, { status: 400 })
      }
      patch.is_active = body.is_active
    }

    // --- limits -------------------------------------------------
    if (body.limits !== undefined) {
      const limits = body.limits
      if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) {
        return NextResponse.json(
          { error: 'limits must be a JSON object, e.g. {"seats": 10, "contacts": 5000}' },
          { status: 400 }
        )
      }
      const entries = Object.entries(limits as Record<string, unknown>)
      if (entries.length > MAX_LIMIT_KEYS) {
        return NextResponse.json(
          { error: `limits may hold at most ${MAX_LIMIT_KEYS} keys` },
          { status: 400 }
        )
      }
      const clean: Record<string, number> = {}
      for (const [key, value] of entries) {
        if (!LIMIT_KEY_PATTERN.test(key)) {
          return NextResponse.json(
            {
              error: `limits key '${key}' must be lower case, start with a letter, and use only letters, digits and underscores`,
            },
            { status: 400 }
          )
        }
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
          return NextResponse.json(
            {
              error: `limits.${key} must be a whole number of zero or more. Leave the key out entirely to mean "no ceiling".`,
            },
            { status: 400 }
          )
        }
        clean[key] = value
      }
      patch.limits = clean
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }

    // Read first: the audit row has to carry what the value was, and a
    // 404 must not be reported as a successful no-op update.
    const { data: before, error: beforeError } = await ctx.db
      .from('platform_plans')
      .select(PLAN_SELECT)
      .eq('code', code)
      .maybeSingle()

    if (beforeError) {
      console.error('[PATCH /api/platform/plans] fetch error:', beforeError)
      return NextResponse.json({ error: 'Failed to load the plan' }, { status: 500 })
    }
    if (!before) {
      return NextResponse.json(
        { error: `No plan is registered under the code '${code}'` },
        { status: 404 }
      )
    }

    const { data: plan, error: updateError } = await ctx.db
      .from('platform_plans')
      .update(patch)
      .eq('code', code)
      .select(PLAN_SELECT)
      .maybeSingle()

    if (updateError) {
      console.error('[PATCH /api/platform/plans] update error:', updateError)
      return NextResponse.json({ error: 'Failed to update the plan' }, { status: 500 })
    }
    if (!plan) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    // How many customers this edit just moved. Retiring a tier does not
    // take anyone off it (`is_active` only hides it from the pickers),
    // so the console needs the number to say what it actually did.
    const { count, error: countError } = await ctx.db
      .from('accounts')
      .select('id', { count: 'exact', head: true })
      .eq('plan', code)
    if (countError) {
      console.warn('[PATCH /api/platform/plans] account count failed:', countError)
    }

    await logPlatformAction(ctx, {
      // Not about one client: this changes the catalogue every client
      // is measured against.
      accountId: null,
      action: 'PLAN_UPDATED',
      detail: {
        code,
        changed: Object.keys(patch),
        before: {
          name: before.name,
          description: before.description,
          limits: before.limits,
          price_note: before.price_note,
          is_active: before.is_active,
        },
        after: {
          name: plan.name,
          description: plan.description,
          limits: plan.limits,
          price_note: plan.price_note,
          is_active: plan.is_active,
        },
        accounts_on_plan: count ?? null,
      },
    })

    return NextResponse.json({ plan, accounts_on_plan: count ?? null })
  } catch (err) {
    return toPlatformErrorResponse(err)
  }
}
