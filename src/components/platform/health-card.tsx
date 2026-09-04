'use client';

// Four yes/no facts about whether a client's install actually works.
// Meta's own status string and error are shown verbatim underneath the
// connection line when the API supplies them: they are the thing an
// operator pastes into a support ticket, so paraphrasing them would
// destroy their value.

import { useTranslations } from 'next-intl';
import { Check, X } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { AccountHealth } from './platform-api';

function Verdict({ ok, okLabel, badLabel }: { ok: boolean; okLabel: string; badLabel: string }) {
  return ok ? (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400">
      <Check className="size-3.5" />
      {okLabel}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-destructive">
      <X className="size-3.5" />
      {badLabel}
    </span>
  );
}

export function HealthCard({ health }: { health: AccountHealth }) {
  const t = useTranslations('Platform');
  const ok = t('health.ok');
  const bad = t('health.bad');

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('detail.health')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-muted-foreground">
            {t('health.connected')}
          </span>
          <Verdict ok={health.whatsapp_connected} okLabel={ok} badLabel={bad} />
        </div>

        {health.whatsapp_status ? (
          <p className="font-mono text-xs text-muted-foreground">
            {health.whatsapp_status}
          </p>
        ) : null}
        {health.whatsapp_error ? (
          <p className="rounded-md bg-destructive/10 px-2 py-1.5 font-mono text-xs text-destructive">
            {health.whatsapp_error}
          </p>
        ) : null}

        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-muted-foreground">
            {t('health.webhook')}
          </span>
          <Verdict ok={health.webhook_recent} okLabel={ok} badLabel={bad} />
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-muted-foreground">
            {t('health.ai')}
          </span>
          <Verdict ok={health.ai_configured} okLabel={ok} badLabel={bad} />
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-muted-foreground">
            {t('health.team')}
          </span>
          {typeof health.people === 'number' && health.people > 0 ? (
            <span className="text-xs font-medium">
              {t('clients.people', { count: health.people })}
            </span>
          ) : (
            <Verdict ok={false} okLabel={ok} badLabel={bad} />
          )}
        </div>
      </CardContent>
    </Card>
  );
}
