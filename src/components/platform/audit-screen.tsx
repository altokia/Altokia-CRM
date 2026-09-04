'use client';

// ============================================================
// /platform/actividad — what Altokia's own people did.
//
// The same rows the affected client can read in their own settings
// (045 makes platform_audit_log readable by the account's admin), so
// this screen is deliberately not editable and not summarised: the
// action verb and its detail payload are shown as recorded.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Loader2, ScrollText, X } from 'lucide-react';
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

/** One-line rendering of the jsonb payload; never invents structure. */
function describeDetail(detail: Record<string, unknown> | null): string | null {
  if (!detail) return null;
  const parts = Object.entries(detail)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) =>
      typeof value === 'object'
        ? `${key}: ${JSON.stringify(value)}`
        : `${key}: ${String(value)}`,
    );
  return parts.length > 0 ? parts.join(' · ') : null;
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

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold tracking-tight">
        {t('audit.title')}
      </h1>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Select
            value={accountId}
            onValueChange={(v) => v && changeAccount(v)}
            disabled={accounts.length === 0}
          >
            <SelectTrigger>
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
              onClick={() => changeAccount('')}
            >
              <X className="size-4" />
            </Button>
          ) : null}
        </div>

        {operators.length > 0 ? (
          <div className="flex items-center gap-1">
            <Select
              value={operator}
              onValueChange={(v) => v && changeOperator(v)}
            >
              <SelectTrigger>
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
                onClick={() => changeOperator('')}
              >
                <X className="size-4" />
              </Button>
            ) : null}
          </div>
        ) : null}

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
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl bg-card px-6 py-14 text-center ring-1 ring-foreground/10">
          <ScrollText className="size-7 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t('audit.empty')}</p>
        </div>
      ) : list.length > 0 ? (
        <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4 text-muted-foreground">
                  {t('audit.operator')}
                </TableHead>
                <TableHead className="text-muted-foreground">
                  {t('audit.action')}
                </TableHead>
                <TableHead className="text-muted-foreground">
                  {t('audit.client')}
                </TableHead>
                <TableHead className="pr-4 text-muted-foreground">
                  {t('audit.when')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((entry) => {
                const detail = describeDetail(entry.detail);
                return (
                  <TableRow key={entry.id}>
                    <TableCell className="pl-4 font-medium">
                      {entry.operator_name ?? '—'}
                    </TableCell>
                    <TableCell className="max-w-md whitespace-normal">
                      <span className="font-mono text-xs">{entry.action}</span>
                      {detail ? (
                        <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
                          {detail}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {entry.account_name ?? '—'}
                    </TableCell>
                    <TableCell className="pr-4 text-muted-foreground">
                      {format.dateTime(new Date(entry.created_at), {
                        day: 'numeric',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
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
    </div>
  );
}
