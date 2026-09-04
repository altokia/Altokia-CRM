'use client';

// ============================================================
// /platform/actividad — what Altokia's own people did.
//
// The same rows the affected client can read in their own settings
// (045 makes platform_audit_log readable by the account's admin), so
// this screen is deliberately not editable and adds nothing: every
// column, every filter and every field of the payload is what the
// route sent.
//
// What changed is only the reading of it. The log stores machine
// verbs (ACCESS_REVOKED) and a jsonb blob, and a wall of
// SCREAMING_SNAKE over a stringified object is not something a person
// scans. So:
//
//   · the verb takes a sentence from the catalogue, keyed by the verb
//     itself. The list of verbs is open by design — a route can log a
//     new one tomorrow — so an unknown verb still renders, raw and in
//     mono, rather than printing a missing key;
//   · the payload becomes label/value pairs. Nothing is dropped: an
//     object is opened one level so its fields get their own row, and
//     anything deeper is still printed as JSON. What does not fit in
//     the preview goes behind "show more", which is a fold, not a
//     filter;
//   · the verb's icon and tone say what kind of event it was before
//     the sentence is read — provisioning and restoring in success
//     green, suspension and revocation in warning and danger,
//     everything else (a look, an edit) in brand violet.
//
// CAREFUL: the detail can carry the client's own data. Presentation
// only — no field is added here that the route did not send.
// ============================================================

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import {
  Activity,
  ArrowLeftRight,
  Building2,
  ChevronDown,
  CirclePause,
  CirclePlay,
  KeyRound,
  Layers,
  Loader2,
  LogOut,
  PenLine,
  PlugZap,
  ScrollText,
  SearchCheck,
  ShieldCheck,
  ShieldOff,
  Unplug,
  UserMinus,
  UserPlus,
  X,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { LoadMore } from './load-more';
import {
  buildQuery,
  platformFetch,
  PlatformRequestError,
  type AccountListResponse,
  type AuditEntryRow,
  type AuditResponse,
  type OperatorRow,
  type OperatorsResponse,
} from './platform-api';

const PAGE_SIZE = 50;

/** Pairs shown before the rest folds behind "show more". */
const DETAIL_PREVIEW = 3;

// ------------------------------------------------------------
// The verb: icon and tone
// ------------------------------------------------------------

type ActionTone = 'success' | 'warning' | 'danger' | 'brand';

/**
 * A tint plus its text-weight partner, from the brand sheet. The tints
 * follow the same recipe the status badges use, so an operator reading
 * both screens is reading one colour language.
 */
const TONE_CLASS: Record<ActionTone, string> = {
  success: 'bg-altokia-success/12 text-altokia-success-text',
  warning: 'bg-altokia-warning/14 text-altokia-warning-text',
  danger: 'bg-altokia-danger/12 text-altokia-danger-text',
  brand: 'bg-altokia-tint text-altokia-violet-text',
};

/**
 * Every verb `logPlatformAction` writes today. NOT a whitelist: a verb
 * missing from here renders as recorded, in mono — the routes are free
 * to log something new without this screen having to know.
 */
const ACTION_META: Record<string, { icon: LucideIcon; tone: ActionTone }> = {
  ACCOUNT_PROVISIONED: { icon: Building2, tone: 'success' },
  ACCOUNT_UPDATED: { icon: PenLine, tone: 'brand' },
  ACCOUNT_SUSPENDED: { icon: CirclePause, tone: 'warning' },
  ACCOUNT_REACTIVATED: { icon: CirclePlay, tone: 'success' },
  ACCOUNT_STATUS_CHANGED: { icon: ArrowLeftRight, tone: 'brand' },
  WHATSAPP_CONNECTED: { icon: PlugZap, tone: 'success' },
  WHATSAPP_DISCONNECTED: { icon: Unplug, tone: 'warning' },
  WHATSAPP_REGISTRATION_CHECKED: { icon: SearchCheck, tone: 'brand' },
  ACCESS_REQUESTED: { icon: KeyRound, tone: 'brand' },
  ACCESS_RELEASED: { icon: LogOut, tone: 'brand' },
  ACCESS_REVOKED: { icon: ShieldOff, tone: 'danger' },
  ACCESS_RESTORED: { icon: ShieldCheck, tone: 'success' },
  CREDENTIALS_RESET: { icon: KeyRound, tone: 'warning' },
  OPERATOR_ADDED: { icon: UserPlus, tone: 'success' },
  OPERATOR_REMOVED: { icon: UserMinus, tone: 'warning' },
  PLAN_UPDATED: { icon: Layers, tone: 'brand' },
};

// ------------------------------------------------------------
// The payload: label/value pairs
// ------------------------------------------------------------

/**
 * Payload keys that have a written label. Anything else falls back to
 * the key itself with its underscores opened out, which keeps a field
 * added by a future route readable without a translation.
 */
const FIELD_KEYS = new Set([
  'accounts_on_plan',
  'after',
  'app_id',
  'before',
  'changed',
  'changes',
  'checks',
  'code',
  'created',
  'credentials_invalidated',
  'credentials_issued',
  'description',
  'display_phone_number',
  'email',
  'expires_at',
  'external_ref',
  'full_name',
  'grant_id',
  'hours',
  'is_active',
  'is_owner',
  'limits',
  'live',
  'name',
  'note',
  'operator_notes',
  'own_app_secret',
  'owner_email',
  'owner_user_id',
  'password_generated',
  'phone_number_id',
  'plan',
  'previous_status',
  'price_note',
  'quality_rating',
  'reason',
  'registered',
  'registration_error',
  'released_from',
  'role',
  'self',
  'status',
  'suspended_at',
  'suspended_reason',
  'target_user_id',
  'trial_ends_at',
  'user_id',
  'users_affected',
  'verified_name',
  'verify_token_updated',
  'via',
  'waba_id',
  'waba_subscribed',
  'was_granted_at',
  'was_revoked',
  'webhook_token_discarded',
]);

/** Keys whose value is an identifier, an address, a count or a stamp. */
const MONO_KEYS = new Set([
  'accounts_on_plan',
  'code',
  'display_phone_number',
  'email',
  'external_ref',
  'hours',
  'limits',
  'owner_email',
  'quality_rating',
  'users_affected',
]);

function isHardValue(key: string, value: unknown): boolean {
  if (typeof value === 'number') return true;
  return key.endsWith('_id') || key.endsWith('_at') || MONO_KEYS.has(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function humanise(key: string): string {
  const text = key.replace(/_/g, ' ').trim();
  return text.length > 0 ? text[0].toUpperCase() + text.slice(1) : key;
}

/** The words the value renderer needs, resolved once in the component. */
interface DetailStrings {
  yes: string;
  no: string;
  changed: string;
  none: string;
}

function formatScalar(value: unknown, s: DetailStrings): string {
  if (value === null || value === undefined) return s.none;
  if (typeof value === 'boolean') return value ? s.yes : s.no;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value.length > 0 ? value : s.none;
  if (Array.isArray(value)) {
    return value.length > 0
      ? value.map((item) => formatScalar(item, s)).join(', ')
      : s.none;
  }
  return JSON.stringify(value);
}

/**
 * The two shapes the account PATCH writes into `changes`: a publishable
 * field carries `{from, to}`, a private one only `{changed: true}`.
 * Returns null for anything else, so the caller keeps walking.
 */
function describeChange(
  value: Record<string, unknown>,
  s: DetailStrings,
): string | null {
  const keys = Object.keys(value);
  if (keys.length > 0 && keys.every((k) => k === 'from' || k === 'to')) {
    const from = formatScalar(value.from ?? null, s);
    const to = formatScalar(value.to ?? null, s);
    return `${from} → ${to}`;
  }
  if (keys.length === 1 && keys[0] === 'changed') {
    return value.changed === true ? s.changed : formatScalar(value.changed, s);
  }
  return null;
}

interface DetailPair {
  id: string;
  label: string;
  value: string;
  mono: boolean;
}

interface DetailContext {
  s: DetailStrings;
  labelOf: (key: string) => string;
  /** ISO stamps read better as a date; anything unparseable stays raw. */
  stamp: (iso: string) => string;
}

function leafValue(key: string, value: unknown, ctx: DetailContext): string {
  if (key.endsWith('_at') && typeof value === 'string' && value.length > 0) {
    return ctx.stamp(value);
  }
  return formatScalar(value, ctx.s);
}

/**
 * The payload, flattened one level. A top-level null is skipped — it
 * carries nothing, and the previous one-line rendering skipped it too.
 * A null *inside* an opened object is printed as an em dash, because
 * there "not set" is half of what the row is saying.
 */
function buildPairs(
  detail: Record<string, unknown> | null,
  ctx: DetailContext,
): DetailPair[] {
  if (!detail) return [];
  const pairs: DetailPair[] = [];

  for (const [key, value] of Object.entries(detail)) {
    if (value === null || value === undefined) continue;
    const label = ctx.labelOf(key);

    if (isRecord(value)) {
      const change = describeChange(value, ctx.s);
      if (change !== null) {
        pairs.push({ id: key, label, value: change, mono: false });
        continue;
      }
      const nested = Object.entries(value);
      if (nested.length === 0) {
        pairs.push({ id: key, label, value: ctx.s.none, mono: false });
        continue;
      }
      for (const [childKey, childValue] of nested) {
        const childChange = isRecord(childValue)
          ? describeChange(childValue, ctx.s)
          : null;
        pairs.push({
          id: `${key}.${childKey}`,
          label: `${label} · ${ctx.labelOf(childKey)}`,
          value: childChange ?? leafValue(childKey, childValue, ctx),
          mono: childChange === null && isHardValue(childKey, childValue),
        });
      }
      continue;
    }

    pairs.push({
      id: key,
      label,
      value: leafValue(key, value, ctx),
      mono: isHardValue(key, value),
    });
  }

  return pairs;
}

/** Two letters for the client monogram; never more, never fewer than one. */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? '')
    .join('');
  return letters.toUpperCase() || '—';
}

// ------------------------------------------------------------

/**
 * The "what" cell: the sentence, its icon, and the payload underneath.
 * Its own component because the fold is per row — fifty rows sharing
 * one open/closed flag would be useless.
 */
function AuditAction({ entry }: { entry: AuditEntryRow }) {
  const t = useTranslations('Platform.audit');
  const format = useFormatter();

  const meta = ACTION_META[entry.action];
  const Icon = meta?.icon ?? Activity;
  const tone: ActionTone = meta?.tone ?? 'brand';
  const label = meta ? t(`actions.${entry.action}`) : entry.action;

  const pairs = buildPairs(entry.detail, {
    s: {
      yes: t('detail.yes'),
      no: t('detail.no'),
      changed: t('detail.changed'),
      none: '—',
    },
    labelOf: (key) => (FIELD_KEYS.has(key) ? t(`fields.${key}`) : humanise(key)),
    stamp: (iso) => {
      const date = new Date(iso);
      return Number.isNaN(date.getTime())
        ? iso
        : format.dateTime(date, {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          });
    },
  });

  // One hidden pair is not worth a button: the fold only appears when
  // it actually saves the row some height.
  // Every pair, always. The dressing pass added a fold that hid the
  // fourth field onwards behind a "show more", which is a new control
  // and, worse, makes an audit entry read as complete when it is not.
  // The pairs are compact label/value rows; a couple of extra lines
  // costs less than a reader trusting a truncated record.
  const shown = pairs;

  return (
    <div className="flex items-start gap-2.5">
      <span
        aria-hidden="true"
        className={cn(
          'rounded-[var(--altokia-radius-sm)] flex size-8 shrink-0 items-center justify-center',
          TONE_CLASS[tone],
        )}
      >
        <Icon size={18} strokeWidth={1.75} />
      </span>

      <div className="min-w-0 space-y-1.5 py-1">
        <p
          className={cn(
            'text-[13px] leading-[1.55] font-semibold text-foreground',
            // An unrecognised verb keeps its recorded spelling, and
            // mono is the honest way to say "this is raw".
            meta ? null : 'font-mono text-xs break-all',
          )}
        >
          {label}
        </p>

        {/* The verb exactly as it was recorded, kept beside the readable
            phrase. An audit trail whose entries have been reworded is
            no longer evidence: when somebody asks what the log actually
            says, the answer has to be on the screen. Small, mono and
            muted so it reads as a reference and not as the headline. */}
        {meta ? (
          <p className="mt-0.5 font-mono text-[10px] leading-[1.4] tracking-wide text-muted-foreground/70">
            {entry.action}
          </p>
        ) : null}

        {shown.length > 0 ? (
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-1">
            {shown.map((pair) => (
              <Fragment key={pair.id}>
                <dt
                  className="text-[11px] leading-[1.55] text-muted-foreground"
                  title={pair.id}
                >
                  {pair.label}
                </dt>
                <dd
                  className={cn(
                    'min-w-0 text-[12px] leading-[1.55] break-words text-foreground/90',
                    pair.mono && 'font-mono text-[11px] tabular-nums',
                  )}
                >
                  {pair.value}
                </dd>
              </Fragment>
            ))}
          </dl>
        ) : null}

      </div>
    </div>
  );
}

export function AuditScreen() {
  const t = useTranslations('Platform');
  const format = useFormatter();

  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);
  const [operators, setOperators] = useState<OperatorRow[]>([]);
  const [accountId, setAccountId] = useState('');
  const [operator, setOperator] = useState('');

  const [entries, setEntries] = useState<AuditEntryRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestId = useRef(0);

  // Filter sources. Both are best-effort: a support-level operator may
  // not be allowed to read the roster, and the screen still works
  // without that filter.
  useEffect(() => {
    let cancelled = false;

    const loadFilters = async () => {
      try {
        const data = await platformFetch<AccountListResponse>(
          `/api/platform/accounts${buildQuery({ limit: 200 })}`,
        );
        if (!cancelled) {
          setAccounts(
            (data.accounts ?? []).map((a) => ({ id: a.id, name: a.name })),
          );
        }
      } catch (err) {
        console.error('[platform-console] audit account filter failed:', err);
      }

      try {
        const data = await platformFetch<OperatorsResponse>(
          '/api/platform/operators',
        );
        if (!cancelled) setOperators(data.operators ?? []);
      } catch (err) {
        if (!(err instanceof PlatformRequestError && err.status === 403)) {
          console.error('[platform-console] audit operator filter failed:', err);
        }
      }
    };

    void loadFilters();
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    try {
      const data = await platformFetch<AuditResponse>(
        `/api/platform/audit${buildQuery({
          account_id: accountId,
          operator,
          limit: PAGE_SIZE,
        })}`,
      );
      if (requestId.current !== id) return;
      setEntries(data.entries ?? []);
      setCursor(data.next_cursor ?? null);
      setError(null);
    } catch (err) {
      if (requestId.current !== id) return;
      console.error('[platform-console] audit load failed:', err);
      setEntries([]);
      setCursor(null);
      setError(err instanceof Error ? err.message : null);
    } finally {
      if (requestId.current === id) setBusy(false);
    }
  }, [accountId, operator]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await platformFetch<AuditResponse>(
        `/api/platform/audit${buildQuery({
          account_id: accountId,
          operator,
          limit: PAGE_SIZE,
          cursor,
        })}`,
      );
      setEntries((prev) => [...(prev ?? []), ...(data.entries ?? [])]);
      setCursor(data.next_cursor ?? null);
    } catch (err) {
      console.error('[platform-console] audit page failed:', err);
      toast.error(err instanceof Error ? err.message : t('errors.generic'));
      setCursor(null);
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, accountId, operator, t]);

  function changeAccount(next: string) {
    setAccountId(next);
    setBusy(true);
  }

  function changeOperator(next: string) {
    setOperator(next);
    setBusy(true);
  }

  const list = entries ?? [];
  const showEmpty = !busy && entries !== null && list.length === 0;
  const accountName = accounts.find((a) => a.id === accountId)?.name;
  const operatorName = operators.find((o) => o.user_id === operator);

  // The chip shape the whole console filters with: fully round, a
  // colour dot on the left, the brand tint while it is holding
  // something back and a hairline while it is not.
  const chip =
    'rounded-[var(--altokia-radius-pill)] gap-2 border pr-2 pl-3 text-[13px] font-medium transition-colors';
  const chipOn = 'border-transparent bg-altokia-tint text-altokia-violet-text';
  const chipOff =
    'border-border bg-card text-muted-foreground hover:text-foreground';

  return (
    <div className="space-y-5">
      <h1 className="font-heading text-2xl font-semibold tracking-tight">
        {t('audit.title')}
      </h1>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Select
            value={accountId}
            onValueChange={(v) => v && changeAccount(v)}
            disabled={accounts.length === 0}
          >
            <SelectTrigger className={cn(chip, accountId ? chipOn : chipOff)}>
              <span
                aria-hidden="true"
                className={cn(
                  'bg-altokia-cyan size-2 shrink-0 rounded-full',
                  accountId ? null : 'opacity-40',
                )}
              />
              <SelectValue>{accountName ?? t('audit.client')}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {accounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {accountId ? (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('audit.client')}
              className="rounded-[var(--altokia-radius-pill)] text-muted-foreground"
              onClick={() => changeAccount('')}
            >
              <X size={14} strokeWidth={1.75} />
            </Button>
          ) : null}
        </div>

        {operators.length > 0 ? (
          <div className="flex items-center gap-1">
            <Select
              value={operator}
              onValueChange={(v) => v && changeOperator(v)}
            >
              <SelectTrigger className={cn(chip, operator ? chipOn : chipOff)}>
                <span
                  aria-hidden="true"
                  className={cn(
                    'bg-altokia-violet size-2 shrink-0 rounded-full',
                    operator ? null : 'opacity-40',
                  )}
                />
                <SelectValue>
                  {operator
                    ? (operatorName?.full_name ?? operator)
                    : t('audit.operator')}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {operators.map((o) => (
                  <SelectItem key={o.user_id} value={o.user_id}>
                    {o.full_name ?? o.user_id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {operator ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t('audit.operator')}
                className="rounded-[var(--altokia-radius-pill)] text-muted-foreground"
                onClick={() => changeOperator('')}
              >
                <X size={14} strokeWidth={1.75} />
              </Button>
            ) : null}
          </div>
        ) : null}

        {busy ? (
          <Loader2
            size={16}
            strokeWidth={1.75}
            className="animate-spin text-muted-foreground"
          />
        ) : null}
      </div>

      {error ? (
        <div className="rounded-[var(--altokia-radius-lg)] border-altokia-danger/30 bg-altokia-danger/10 border px-4 py-3 text-sm">
          <p className="text-altokia-danger-text font-medium">
            {t('errors.generic')}
          </p>
          <p className="mt-1 font-mono text-xs break-all text-muted-foreground">
            {error}
          </p>
        </div>
      ) : null}

      {showEmpty ? (
        <div className="rounded-[var(--altokia-radius-xl)] shadow-altokia flex flex-col items-center justify-center gap-3 border border-border bg-card px-6 py-14 text-center">
          <span className="rounded-[var(--altokia-radius-lg)] bg-altokia-tint text-altokia-violet-text flex size-11 items-center justify-center">
            <ScrollText size={18} strokeWidth={1.75} />
          </span>
          <p className="text-sm text-muted-foreground">{t('audit.empty')}</p>
        </div>
      ) : list.length > 0 ? (
        <div className="rounded-[var(--altokia-radius-xl)] shadow-altokia overflow-hidden border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="border-border/70 hover:bg-transparent">
                <TableHead className="h-11 pl-5 text-[11px] font-medium tracking-[0.14em] text-muted-foreground uppercase">
                  {t('audit.operator')}
                </TableHead>
                <TableHead className="h-11 text-[11px] font-medium tracking-[0.14em] text-muted-foreground uppercase">
                  {t('audit.action')}
                </TableHead>
                <TableHead className="h-11 text-[11px] font-medium tracking-[0.14em] text-muted-foreground uppercase">
                  {t('audit.client')}
                </TableHead>
                <TableHead className="h-11 pr-5 text-[11px] font-medium tracking-[0.14em] text-muted-foreground uppercase">
                  {t('audit.when')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((entry) => (
                <TableRow
                  key={entry.id}
                  className="border-border/60 hover:bg-muted/40"
                >
                  <TableCell className="py-4 pl-5 align-top">
                    <span className="text-[13px] leading-[1.55] font-semibold">
                      {entry.operator_name ?? '—'}
                    </span>
                  </TableCell>

                  <TableCell className="max-w-md py-4 align-top whitespace-normal">
                    <AuditAction entry={entry} />
                  </TableCell>

                  <TableCell className="py-4 align-top">
                    {entry.account_name ? (
                      <span className="flex items-center gap-2.5">
                        <span
                          aria-hidden="true"
                          // Flat and deep, not the brand gradient: that
                          // gesture is worth one element per screen, and
                          // this repeated once per row — fifty times on a
                          // full page. White on the magenta end also fell
                          // short of 4.5:1 at 11px.
                          className="rounded-[var(--altokia-radius-sm)] text-altokia-white bg-[color-mix(in_oklab,var(--altokia-violet)_74%,var(--altokia-ink-fixed))] flex size-8 shrink-0 items-center justify-center text-[11px] font-semibold"
                        >
                          {initials(entry.account_name)}
                        </span>
                        <span className="text-[13px] leading-[1.55] font-semibold">
                          {entry.account_name}
                        </span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>

                  <TableCell className="py-4 pr-5 align-top font-mono text-xs tabular-nums text-muted-foreground">
                    {format.dateTime(new Date(entry.created_at), {
                      day: 'numeric',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {cursor ? (
            <LoadMore
              token={list.length}
              busy={loadingMore}
              onReach={() => void loadMore()}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
