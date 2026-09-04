'use client';

// ============================================================
// /platform — the roster of every business on the platform.
//
// This is the screen an operator lives in, so it is a dense table
// rather than a wall of cards, and it is built to answer one question
// before any other: who is broken right now. A suspended client and a
// client whose number was never connected both carry an alarm tone on
// the row itself, so the answer survives a glance at fifty rows.
//
// Filtering by status is a set of chips rather than a dropdown with an
// "all" entry: clicking the active chip clears it, which maps exactly
// onto the route's optional `status` parameter.
//
// DRESS. The Altokia design system, and only the dress: the columns,
// their order, the filters and where every value comes from are
// untouched. What the palette adds is a reading order — the brand
// gradient is spent once, on the primary button; the four status
// colours appear twice each (the chip dot and the badge) and nowhere
// else; hard data (phone numbers, dates) goes to the mono face with
// tabular figures so a column of them lines up; and "not connected"
// is amber rather than red, because a number nobody has wired up yet
// is a pending job, not a fault.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import {
  AlertTriangle,
  Building2,
  Loader2,
  Lock,
  Plus,
  Search,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import {
  ACCOUNT_STATUSES,
  accountPeople,
  buildQuery,
  platformFetch,
  type AccountListResponse,
  type AccountListRow,
  type AccountStatus,
} from './platform-api';
import { LoadMore } from './load-more';
import { NewClientDialog } from './new-client-dialog';
import { AccessBadge, StatusBadge, STATUS_COLOR } from './status-badge';
import { planLabel, usePlans } from './use-plans';

const PAGE_SIZE = 50;

/** The gradient the primary button wears, and nothing else on this screen. */
const BRAND_GRADIENT = 'var(--altokia-gradient)';

/** One button, used twice: the header and the empty state offer the same act. */
const PRIMARY_BUTTON =
  'h-10 gap-2 rounded-[var(--altokia-radius-md)] border-transparent px-4 text-sm font-semibold text-altokia-white shadow-altokia hover:opacity-90';

/** Table headers: small caps, wide tracking, soft ink. */
const HEAD =
  'h-10 text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase';

/**
 * The avatar palette. Five pairs, all drawn from the three brand hues
 * — and deliberately never violet→magenta, which is the brand gradient
 * itself and belongs to the primary button alone. The semantic three
 * (success, warning, danger) are kept out on purpose: on this screen
 * those colours mean a state, and a client whose initials happened to
 * come out amber would read as a client somebody suspended.
 */
// Every pair is darkened toward the ink before it is used. The bright
// brand hues are display colours, not backgrounds for 12px type: white
// initials on the raw cyan measured 1.73:1 and on the raw magenta
// 3.46:1, so two thirds of the client list had an unreadable monogram.
// Mixing 30% of the ink in costs nothing visually at this size and
// takes every pair past 4.5:1.
const deep = (token: string) =>
  `color-mix(in oklab, var(${token}) 70%, var(--altokia-ink-fixed))`;

const AVATAR_GRADIENTS = [
  `linear-gradient(135deg, ${deep('--altokia-cyan')}, ${deep('--altokia-violet')})`,
  `linear-gradient(135deg, ${deep('--altokia-violet')}, ${deep('--altokia-cyan')})`,
  `linear-gradient(135deg, ${deep('--altokia-magenta')}, ${deep('--altokia-cyan')})`,
  `linear-gradient(135deg, ${deep('--altokia-cyan')}, ${deep('--altokia-magenta')})`,
  `linear-gradient(135deg, ${deep('--altokia-magenta')}, ${deep('--altokia-violet')})`,
] as const;

/**
 * A pure function of the name, so one business wears the same colour
 * on every page, in every session, for every operator — which is the
 * only thing that makes a decorative colour worth having. Nothing
 * random and nothing time-based: the compiler lint forbids both in
 * render, and an avatar that reshuffled on each load would be worse
 * than no avatar at all.
 */
function nameHash(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) % 1000003;
  }
  return hash;
}

function avatarGradient(name: string): string {
  return AVATAR_GRADIENTS[nameHash(name) % AVATAR_GRADIENTS.length];
}

/**
 * Two letters: one from each of the first two words, or the first two
 * of a single-word name. Split by code point, not by index, so a name
 * that starts outside the BMP does not come out as half a character.
 */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const first = [...words[0]];
  const letters =
    words.length > 1
      ? `${first[0] ?? ''}${[...words[1]][0] ?? ''}`
      : first.slice(0, 2).join('');
  return letters.toUpperCase();
}

export function ClientsScreen() {
  const t = useTranslations('Platform');
  const tStatus = useTranslations('Platform.status');
  const format = useFormatter();
  // The roster prints tier names, not the codes stored on the row.
  const { plans } = usePlans();

  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [status, setStatus] = useState<AccountStatus | null>(null);

  const [rows, setRows] = useState<AccountListRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  // Guards against a slow first page landing on top of a fast second
  // one when the operator keeps typing.
  const requestId = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    try {
      const data = await platformFetch<AccountListResponse>(
        `/api/platform/accounts${buildQuery({
          q: debounced,
          status,
          limit: PAGE_SIZE,
        })}`,
      );
      if (requestId.current !== id) return;
      setRows(data.accounts ?? []);
      setCursor(data.next_cursor ?? null);
      setError(null);
    } catch (err) {
      if (requestId.current !== id) return;
      console.error('[platform-console] clients load failed:', err);
      setRows([]);
      setCursor(null);
      setError(err instanceof Error ? err.message : null);
    } finally {
      if (requestId.current === id) setBusy(false);
    }
  }, [debounced, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await platformFetch<AccountListResponse>(
        `/api/platform/accounts${buildQuery({
          q: debounced,
          status,
          limit: PAGE_SIZE,
          cursor,
        })}`,
      );
      setRows((prev) => [...(prev ?? []), ...(data.accounts ?? [])]);
      setCursor(data.next_cursor ?? null);
    } catch (err) {
      console.error('[platform-console] clients page failed:', err);
      toast.error(err instanceof Error ? err.message : t('errors.generic'));
      setCursor(null);
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore, debounced, status, t]);

  function changeQuery(value: string) {
    setQuery(value);
    setBusy(true);
  }

  function toggleStatus(next: AccountStatus) {
    setStatus((prev) => (prev === next ? null : next));
    setBusy(true);
  }

  const list = rows ?? [];
  const showEmpty = !busy && rows !== null && list.length === 0;
  // "No clients yet" invites you to create the first one. A search that
  // matched nothing does not — the client you are looking for probably
  // exists under another name, and offering to provision a duplicate is
  // the wrong nudge.
  const filtering = debounced.length > 0 || status !== null;

  return (
    <div className="space-y-[var(--altokia-space-3)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="font-altokia-display text-[26px] leading-tight font-bold tracking-tight">
          {t('clients.title')}
        </h1>
        {/* The single brand gesture on the screen. Everything else
            that wants to look important takes the violet tint. */}
        <Button
          onClick={() => setCreateOpen(true)}
          className={PRIMARY_BUTTON}
          style={{ backgroundImage: BRAND_GRADIENT }}
        >
          <Plus size={18} strokeWidth={1.75} className="size-[18px]" />
          {t('clients.new')}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-56 flex-1 sm:max-w-sm">
          <Search
            size={18}
            strokeWidth={1.75}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(e) => changeQuery(e.target.value)}
            placeholder={t('clients.search')}
            className="h-10 rounded-[var(--altokia-radius-md)] border-border bg-card pl-10 text-sm"
          />
        </div>

        {/* Each chip carries its own state's colour as a 6px dot, so
            the filter and the badge two columns away agree on sight. */}
        <div className="flex flex-wrap gap-2">
          {ACCOUNT_STATUSES.map((value) => {
            const active = status === value;
            return (
              <button
                key={value}
                type="button"
                aria-pressed={active}
                onClick={() => toggleStatus(value)}
                className={cn(
                  'inline-flex items-center gap-2 rounded-[var(--altokia-radius-pill)] border px-3.5 py-2 text-[13px] font-medium transition-colors',
                  active
                    ? 'border-transparent bg-altokia-tint text-altokia-violet-text'
                    : 'border-border bg-card text-muted-foreground hover:text-foreground',
                )}
              >
                <span
                  aria-hidden="true"
                  className="size-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: STATUS_COLOR[value] }}
                />
                {tStatus(value)}
              </button>
            );
          })}
        </div>

        {busy ? (
          <Loader2
            size={18}
            strokeWidth={1.75}
            className="animate-spin text-muted-foreground"
          />
        ) : null}
      </div>

      {error ? (
        // Tinted with the danger colour, because the empty state renders
        // on the same load: two identical panels meant "no clients yet"
        // and "the list failed to load" were indistinguishable.
        <div className="rounded-[var(--altokia-radius-lg)] border border-altokia-danger/[35%] bg-altokia-danger/[8%] px-4 py-3.5 shadow-altokia">
          <p className="text-sm font-semibold text-altokia-danger-text">
            {t('errors.generic')}
          </p>
          <p className="mt-1 font-mono text-xs leading-[1.55] text-muted-foreground">
            {error}
          </p>
        </div>
      ) : null}

      {showEmpty ? (
        <div className="flex flex-col items-center justify-center gap-4 rounded-[var(--altokia-radius-lg)] border border-border bg-card px-6 py-14 text-center shadow-altokia">
          <span className="flex size-11 items-center justify-center rounded-[var(--altokia-radius-md)] bg-altokia-tint">
            <Building2
              size={18}
              strokeWidth={1.75}
              className="text-altokia-violet-text"
            />
          </span>
          <p className="text-sm leading-[1.55] text-muted-foreground">
            {t('clients.empty')}
          </p>
          {filtering ? null : (
            <Button
              onClick={() => setCreateOpen(true)}
              className={PRIMARY_BUTTON}
              style={{ backgroundImage: BRAND_GRADIENT }}
            >
              <Plus size={18} strokeWidth={1.75} className="size-[18px]" />
              {t('clients.new')}
            </Button>
          )}
        </div>
      ) : list.length > 0 ? (
        <div className="overflow-x-auto rounded-[var(--altokia-radius-lg)] border border-border bg-card shadow-altokia">
          <Table>
            <TableHeader>
              <TableRow className="border-border bg-card-2 hover:bg-card-2">
                <TableHead className={cn(HEAD, 'pl-4')}>
                  {t('clients.name')}
                </TableHead>
                <TableHead className={HEAD}>{t('clients.status')}</TableHead>
                <TableHead className={HEAD}>{t('clients.plan')}</TableHead>
                <TableHead className={HEAD}>{t('clients.number')}</TableHead>
                <TableHead className={HEAD}>{t('health.team')}</TableHead>
                <TableHead className={HEAD}>
                  {t('clients.lastActivity')}
                </TableHead>
                <TableHead className={cn(HEAD, 'pr-4')}>
                  {t('clients.created')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((row) => {
                const disconnected = !row.whatsapp?.connected;
                const suspended =
                  row.status === 'suspended' || row.status === 'cancelled';
                // Revoked and suspended are different problems that
                // happen to share a colour, so the marker differs: a
                // padlock for "cannot sign in", the alarm triangle for
                // "service stopped".
                const revoked = Boolean(row.access_revoked_at);
                const people = accountPeople(row);
                return (
                  <TableRow
                    key={row.id}
                    className={cn(
                      'border-b border-border/60 border-l-2 hover:bg-card-2',
                      suspended || revoked
                        ? 'border-l-altokia-danger bg-altokia-danger/[6%]'
                        : disconnected
                          ? 'border-l-altokia-warning'
                          : 'border-l-transparent',
                    )}
                  >
                    <TableCell className="py-3.5 pl-4 font-medium">
                      <Link
                        href={`/platform/clientes/${row.id}`}
                        className="flex items-center gap-3 hover:text-altokia-violet-text"
                      >
                        {/* Colour derived from the name, so the eye
                            recognises a client it already knows before
                            it has read a single word. */}
                        <span
                          aria-hidden="true"
                          className="flex size-[34px] shrink-0 items-center justify-center rounded-[var(--altokia-radius-sm)] text-[12px] font-bold tracking-wide text-altokia-white"
                          style={{ backgroundImage: avatarGradient(row.name) }}
                        >
                          {initials(row.name)}
                        </span>
                        {revoked ? (
                          <Lock
                            size={18}
                            strokeWidth={1.75}
                            className="shrink-0 text-altokia-danger-text"
                          />
                        ) : suspended || disconnected ? (
                          <AlertTriangle
                            size={18}
                            strokeWidth={1.75}
                            className={cn(
                              'shrink-0',
                              suspended
                                ? 'text-altokia-danger-text'
                                : 'text-altokia-warning-text',
                            )}
                          />
                        ) : null}
                        <span className="truncate text-sm leading-[1.55] font-semibold">
                          {row.name}
                        </span>
                      </Link>
                    </TableCell>

                    <TableCell className="py-3.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <StatusBadge status={row.status} />
                        <AccessBadge revokedAt={row.access_revoked_at} />
                      </div>
                    </TableCell>

                    <TableCell className="py-3.5 text-[13px] leading-[1.55] text-muted-foreground">
                      {planLabel(plans, row.plan) ?? '—'}
                    </TableCell>

                    <TableCell className="py-3.5">
                      {row.whatsapp?.connected ? (
                        <span className="font-mono text-[13px] tabular-nums text-muted-foreground">
                          {row.whatsapp.display_phone_number || '—'}
                        </span>
                      ) : (
                        // Amber, not red. Nobody has wired this number
                        // up yet: that is a job still in the queue, and
                        // a roster that shouts at every one of them
                        // stops being read at all.
                        <span className="text-[13px] font-medium text-altokia-warning-text">
                          {t('clients.notConnected')}
                        </span>
                      )}
                    </TableCell>

                    <TableCell className="py-3.5 text-[13px] leading-[1.55] tabular-nums text-muted-foreground">
                      {people === null
                        ? t('health.bad')
                        : t('clients.people', { count: people })}
                    </TableCell>

                    <TableCell className="py-3.5 text-[13px] leading-[1.55] tabular-nums text-muted-foreground">
                      {row.last_activity_at
                        ? format.relativeTime(new Date(row.last_activity_at))
                        : t('clients.never')}
                    </TableCell>

                    <TableCell className="py-3.5 pr-4 font-mono text-[13px] tabular-nums text-muted-foreground">
                      {format.dateTime(new Date(row.created_at), {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                    </TableCell>
                  </TableRow>
                );
              })}
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

      <NewClientDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => void load()}
      />
    </div>
  );
}
