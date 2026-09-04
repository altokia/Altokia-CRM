import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  isTerminologyKey,
  normalizeTerminology,
  TERM_MAX_LENGTH,
} from '@/lib/terminology'

/**
 * /api/account/terminology — what this business calls things.
 *
 *   GET                        any member — the words every screen reads.
 *   PATCH { terminology }      admin — replaces the whole map.
 *
 * The PATCH replaces rather than merges (unlike its sibling
 * /api/account/routing, whose JSON carries state the UI never sees):
 * the settings form always submits every key, and clearing a field
 * there has to be able to *remove* an override — a merge could only
 * ever add words, never take one back.
 */

export async function GET() {
  try {
    const ctx = await getCurrentAccount()

    const { data, error } = await ctx.supabase
      .from('accounts')
      .select('terminology')
      .eq('id', ctx.accountId)
      .maybeSingle()
    if (error || !data) {
      console.error('[GET /api/account/terminology] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load terminology' }, { status: 500 })
    }

    return NextResponse.json({ terminology: normalizeTerminology(data.terminology) })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireRole('admin')

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const raw = body.terminology
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return NextResponse.json({ error: 'terminology must be an object' }, { status: 400 })
    }

    const entries = Object.entries(raw as Record<string, unknown>)

    // normalizeTerminology would drop an unknown key silently, and the
    // save would then look like it worked while the word never changed
    // anywhere. Reject instead, so a typo surfaces at the source.
    const unknown = entries.filter(([key]) => !isTerminologyKey(key)).map(([key]) => key)
    if (unknown.length > 0) {
      // Echo a bounded sample, not the caller's own payload back at
      // them: the point is to name the typo, and a thousand-key body
      // would otherwise become a thousand-key error string.
      const sample = unknown.slice(0, 5).map((key) => key.slice(0, 40))
      const suffix = unknown.length > sample.length ? ` (+${unknown.length - sample.length})` : ''
      return NextResponse.json(
        { error: `Unknown terminology keys: ${sample.join(', ')}${suffix}` },
        { status: 400 },
      )
    }

    for (const [key, value] of entries) {
      if (typeof value !== 'string') {
        return NextResponse.json({ error: `${key} must be a string` }, { status: 400 })
      }
      // Truncating instead would ship a half-word into every header on
      // every screen; the caller should hear about it.
      if (value.trim().length > TERM_MAX_LENGTH) {
        return NextResponse.json(
          { error: `${key} must be ${TERM_MAX_LENGTH} characters or fewer` },
          { status: 400 },
        )
      }
    }

    // Empty values are already gone here — that's how the form clears
    // an override and falls back to the translated word.
    const terminology = normalizeTerminology(raw)

    // accounts_update RLS requires admin+, which requireRole guaranteed.
    const { data, error } = await ctx.supabase
      .from('accounts')
      .update({ terminology })
      .eq('id', ctx.accountId)
      .select('terminology')
      .single()
    if (error) {
      console.error('[PATCH /api/account/terminology] update error:', error)
      return NextResponse.json({ error: 'Failed to update terminology' }, { status: 500 })
    }

    return NextResponse.json({ terminology: normalizeTerminology(data.terminology) })
  } catch (err) {
    return toErrorResponse(err)
  }
}
