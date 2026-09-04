'use client';

// ============================================================
// /platform/clientes/[id] — one business, in the order an operator
// actually needs it:
//
//   1. Is it working?            (health)
//   2. Is it being used?         (usage)
//   3. May I look inside?        (support access — consent, not a
//                                 switch the console can flip itself)
//   4. Is its number connected?  (WhatsApp + the per-client webhook)
//   5. What are we charging?     (commercial settings, suspension)
//
// Every panel re-reads the whole detail after it changes something, so
// what is on screen is always what the server last said — no local
// optimistic guesses about a client's state.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArrowLeft, ExternalLink, Loader2 } from 'lucide-react';

import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { AccessCard } from './access-card';
import { CommercialCard } from './commercial-card';
import { HealthCard } from './health-card';
import { StatusBadge } from './status-badge';
import { UsageCard } from './usage-card';
import { WhatsappCard } from './whatsapp-card';
import { platformFetch, type AccountDetail } from './platform-api';

export function ClientDetail({ accountId }: { accountId: string }) {
  const t = useTranslations('Platform');

  const [detail, setDetail] = useState<AccountDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await platformFetch<AccountDetail>(
        `/api/platform/accounts/${accountId}`,
      );
      setDetail(data);
      setError(null);
    } catch (err) {
      console.error('[platform-console] client detail failed:', err);
      setError(err instanceof Error ? err.message : null);
    }
  }, [accountId]);

  useEffect(() => {
    // `load` awaits before it touches state, so nothing is set during
    // the effect body — the rule cannot see through the async boundary.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const refresh = useCallback(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <div className="space-y-4">
        <Link
          href="/platform"
          aria-label={t('nav.clients')}
          className={cn(buttonVariants({ variant: 'outline', size: 'icon' }))}
        >
          <ArrowLeft className="size-4" />
        </Link>
        <div className="rounded-lg bg-destructive/10 px-4 py-3 text-sm">
          <p className="font-medium text-destructive">{t('errors.generic')}</p>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {error}
          </p>
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const { account } = detail;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/platform"
          aria-label={t('nav.clients')}
          className={cn(buttonVariants({ variant: 'outline', size: 'icon' }))}
        >
          <ArrowLeft className="size-4" />
        </Link>

        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <h1 className="truncate text-2xl font-semibold tracking-tight">
            {account.name}
          </h1>
          <StatusBadge status={account.status} />
        </div>

        {/* Rendered only when the API tells us where the client's CRM
            lives — see AccountRecord.crm_url. */}
        {account.crm_url ? (
          <Link
            href={account.crm_url}
            target="_blank"
            rel="noreferrer noopener"
            className={cn(
              buttonVariants({ variant: 'outline' }),
              'ml-auto',
            )}
          >
            <ExternalLink className="size-4" />
            {t('actions.openCrm')}
          </Link>
        ) : null}
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <HealthCard health={detail.health} />
        <UsageCard usage={detail.usage} />
        <AccessCard
          accountId={account.id}
          access={detail.access}
          onChanged={refresh}
        />
      </div>

      <WhatsappCard
        accountId={account.id}
        whatsapp={detail.whatsapp ?? null}
        onChanged={refresh}
      />

      <CommercialCard account={account} onChanged={refresh} />
    </div>
  );
}
