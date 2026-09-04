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
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { AlertTriangle, Building2, Loader2, Plus, Search } from 'lucide-react';
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
  buildQuery,
  platformFetch,
  type AccountListResponse,
  type AccountListRow,
  type AccountStatus,
} from './platform-api';
import { LoadMore } from './load-more';
import { NewClientDialog } from './new-client-dialog';
import { StatusBadge } from './status-badge';

const PAGE_SIZE = 50;

export function ClientsScreen() {
  const t = useTranslations('Platform');
  const tStatus = useTranslations('Platform.status');
  const format = useFormatter();

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
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">
          {t('clients.title')}
        </h1>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" />
          {t('clients.new')}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-56 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => changeQuery(e.target.value)}
            placeholder={t('clients.search')}
            className="pl-8"
          />
        </div>

        <div className="flex flex-wrap gap-1.5">
          {ACCOUNT_STATUSES.map((value) => {
            const active = status === value;
            return (
              <button
                key={value}
                type="button"
                aria-pressed={active}
                onClick={() => toggleStatus(value)}
                className={cn(
                  'rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                  active
                    ? 'bg-primary-soft-2 text-primary'
                    : 'bg-muted text-muted-foreground hover:text-foreground',
                )}
              >
                {tStatus(value)}
              </button>
            );
          })}
        </div>

        {busy ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : null}
      </div>

      {error ? (
        <div className="rounded-lg bg-destructive/10 px-4 py-3 text-sm">
          <p className="font-medium text-destructive">{t('errors.generic')}</p>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {error}
          </p>
        </div>
      ) : null}

      {showEmpty ? (
        <div className="flex flex-col items-center justify-center gap-4 rounded-xl bg-card px-6 py-14 text-center ring-1 ring-foreground/10">
          <Building2 className="size-7 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t('clients.empty')}</p>
          {filtering ? null : (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" />
              {t('clients.new')}
            </Button>
          )}
        </div>
      ) : list.length > 0 ? (
        <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4 text-muted-foreground">
                  {t('clients.name')}
                </TableHead>
                <TableHead className="text-muted-foreground">
                  {t('clients.status')}
                </TableHead>
                <TableHead className="text-muted-foreground">
                  {t('clients.plan')}
                </TableHead>
                <TableHead className="text-muted-foreground">
                  {t('clients.number')}
                </TableHead>
                <TableHead className="text-muted-foreground">
                  {t('health.team')}
                </TableHead>
                <TableHead className="text-muted-foreground">
                  {t('clients.lastActivity')}
                </TableHead>
                <TableHead className="pr-4 text-muted-foreground">
                  {t('clients.created')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((row) => {
                const disconnected = !row.whatsapp?.connected;
                const suspended =
                  row.status === 'suspended' || row.status === 'cancelled';
                return (
                  <TableRow
                    key={row.id}
                    className={cn(
                      'border-l-2',
                      suspended
                        ? 'border-l-destructive bg-destructive/5'
                        : disconnected
                          ? 'border-l-primary'
                          : 'border-l-transparent',
                    )}
                  >
                    <TableCell className="pl-4 font-medium">
                      <Link
                        href={`/platform/clientes/${row.id}`}
                        className="flex items-center gap-2 hover:text-primary"
                      >
                        {suspended || disconnected ? (
                          <AlertTriangle
                            className={cn(
                              'size-3.5 shrink-0',
                              suspended ? 'text-destructive' : 'text-primary',
                            )}
                          />
                        ) : null}
                        <span className="truncate">{row.name}</span>
                      </Link>
                    </TableCell>

                    <TableCell>
                      <StatusBadge status={row.status} />
                    </TableCell>

                    <TableCell className="text-muted-foreground">
                      {row.plan || '—'}
                    </TableCell>

                    <TableCell>
                      {row.whatsapp?.connected ? (
                        <span className="font-mono text-xs text-muted-foreground">
                          {row.whatsapp.display_phone_number || '—'}
                        </span>
                      ) : (
                        <span className="text-xs font-medium text-destructive">
                          {t('clients.notConnected')}
                        </span>
                      )}
                    </TableCell>

                    <TableCell className="text-muted-foreground">
                      {typeof row.people === 'number'
                        ? t('clients.people', { count: row.people })
                        : t('health.bad')}
                    </TableCell>

                    <TableCell className="text-muted-foreground">
                      {row.last_activity_at
                        ? format.relativeTime(new Date(row.last_activity_at))
                        : t('clients.never')}
                    </TableCell>

                    <TableCell className="pr-4 text-muted-foreground">
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
