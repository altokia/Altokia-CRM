// ============================================================
// /api/platform/audit — everything Altokia did, newest first.
//
// The operator's view of `platform_audit_log`. The customer has their
// own view of the same table, filtered to their account by RLS (045),
// which is the point: "who at Altokia touched my data" is a question
// with an answer, and both sides read the same rows.
//
// Nothing writes here. Entries come from `logPlatformAction` under the
// service role, so an operator cannot forge or erase their own trail.
// ============================================================

import { NextResponse } from 'next/server'

import { requirePlatformOperator, toPlatformErrorResponse } from '@/lib/platform'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface AuditRow {
  id: string
  operator_user_id: string | null
  account_id: string | null
  action: string
  detail: Record<string, unknown> | null
  created_at: string
}

/**
 * GET /api/platform/audit?account_id=&operator=&limit=&cursor=
 *
 * Names are resolved the same way the roster resolves them: collect the
 * distinct ids on the page, then one query per lookup table. A page of
 * 50 entries costs three queries in total, not fifty — and the log is
 * the one screen where a per-row lookup would be most tempting, since
 * every row names a different account and a different colleague.
 *
 * `cursor` is the `created_at` of the last row received (keyset). The
 * log is append-only, so paging can never skip or repeat a row the way
 * an OFFSET would while new entries land at the top.
 */
export async function GET(request: Request) {
  try {
    const ctx = await requirePlatformOperator()

    const url = new URL(request.url)
    const accountId = url.searchParams.get('account_id')
    const operator = url.searchParams.get('operator')
    const cursor = url.searchParams.get('cursor')
    const limitParam = url.searchParams.get('limit')

    if (accountId !== null && !UUID_PATTERN.test(accountId)) {
      return NextResponse.json(
        { error: 'account_id must be a UUID' },
        { status: 400 }
      )
    }
    if (operator !== null && !UUID_PATTERN.test(operator)) {
      return NextResponse.json(
        { error: 'operator must be a user UUID' },
        { status: 400 }
      )
    }
    if (cursor !== null && Number.isNaN(Date.parse(cursor))) {
      return NextResponse.json(
        { error: 'cursor must be the created_at of the last row you received' },
        { status: 400 }
      )
    }

    let limit = DEFAULT_LIMIT
    if (limitParam !== null) {
      const parsed = Number(limitParam)
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
        return NextResponse.json(
          { error: `limit must be an integer between 1 and ${MAX_LIMIT}` },
          { status: 400 }
        )
      }
      limit = parsed
    }

    let query = ctx.db
      .from('platform_audit_log')
      .select('id, operator_user_id, account_id, action, detail, created_at')
      .order('created_at', { ascending: false })
      .limit(limit)

    // Both filters ride the indexes 045 created for exactly these two
    // questions: (account_id, created_at DESC) and
    // (operator_user_id, created_at DESC).
    if (accountId) query = query.eq('account_id', accountId)
    if (operator) query = query.eq('operator_user_id', operator)
    if (cursor) query = query.lt('created_at', cursor)

    const { data, error } = await query
    if (error) {
      console.error('[GET /api/platform/audit] fetch error:', error)
      return NextResponse.json(
        { error: 'Failed to load the audit log' },
        { status: 500 }
      )
    }

    const entries = (data ?? []) as AuditRow[]
    if (entries.length === 0) {
      return NextResponse.json({ entries: [], next_cursor: null })
    }

    const accountIds = Array.from(
      new Set(entries.map((e) => e.account_id).filter((v): v is string => !!v))
    )
    const operatorIds = Array.from(
      new Set(
        entries.map((e) => e.operator_user_id).filter((v): v is string => !!v)
      )
    )

    const [accountResult, profileResult, operatorResult] = await Promise.all([
      accountIds.length
        ? ctx.db.from('accounts').select('id, name').in('id', accountIds)
        : Promise.resolve({ data: [], error: null }),
      operatorIds.length
        ? ctx.db
            .from('profiles')
            .select('user_id, full_name, email')
            .in('user_id', operatorIds)
        : Promise.resolve({ data: [], error: null }),
      operatorIds.length
        ? ctx.db
            .from('platform_operators')
            .select('user_id, full_name, role')
            .in('user_id', operatorIds)
        : Promise.resolve({ data: [], error: null }),
    ])

    // Resolution failures degrade to ids on screen; the trail itself is
    // never withheld because a name could not be looked up.
    if (accountResult.error) {
      console.warn('[GET /api/platform/audit] account names failed:', accountResult.error)
    }
    if (profileResult.error) {
      console.warn('[GET /api/platform/audit] profile names failed:', profileResult.error)
    }
    if (operatorResult.error) {
      console.warn('[GET /api/platform/audit] operator names failed:', operatorResult.error)
    }

    const accountName = new Map<string, string>()
    for (const row of (accountResult.data ?? []) as { id: string; name: string }[]) {
      accountName.set(row.id, row.name)
    }

    const profileById = new Map<string, { full_name: string | null; email: string | null }>()
    for (const row of (profileResult.data ?? []) as {
      user_id: string
      full_name: string | null
      email: string | null
    }[]) {
      profileById.set(row.user_id, { full_name: row.full_name, email: row.email })
    }

    const operatorById = new Map<string, { full_name: string | null; role: string }>()
    for (const row of (operatorResult.data ?? []) as {
      user_id: string
      full_name: string | null
      role: string
    }[]) {
      operatorById.set(row.user_id, { full_name: row.full_name, role: row.role })
    }

    return NextResponse.json({
      entries: entries.map((entry) => {
        const op = entry.operator_user_id
          ? operatorById.get(entry.operator_user_id)
          : null
        const profile = entry.operator_user_id
          ? profileById.get(entry.operator_user_id)
          : null
        return {
          ...entry,
          account_name: entry.account_id
            ? (accountName.get(entry.account_id) ?? null)
            : null,
          operator_name: op?.full_name ?? profile?.full_name ?? null,
          operator_email: profile?.email ?? null,
          // Null when the person has since been taken off the roster —
          // their entries stay, which is the whole point of a log.
          operator_role: op?.role ?? null,
        }
      }),
      next_cursor:
        entries.length === limit ? entries[entries.length - 1].created_at : null,
    })
  } catch (err) {
    return toPlatformErrorResponse(err)
  }
}
