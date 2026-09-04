'use client';

// Consumption over the trailing 30 days. A metric the API did not
// return renders as "Falta", never as 0 — a fabricated zero here is
// indistinguishable from a client who sent nothing, and the two lead
// to opposite support decisions.

import { useFormatter, useTranslations } from 'next-intl';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { AccountUsage } from './platform-api';

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-card-2 px-3 py-2.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

export function UsageCard({ usage }: { usage: AccountUsage }) {
  const t = useTranslations('Platform');
  const format = useFormatter();
  const missing = t('health.bad');

  const count = (value: number | null | undefined) =>
    typeof value === 'number' ? format.number(value) : missing;

  const storage = () => {
    if (typeof usage.storage_bytes !== 'number') return null;
    const mb = usage.storage_bytes / (1024 * 1024);
    return mb >= 1024
      ? format.number(mb / 1024, {
          style: 'unit',
          unit: 'gigabyte',
          maximumFractionDigits: 1,
        })
      : format.number(mb, {
          style: 'unit',
          unit: 'megabyte',
          maximumFractionDigits: 1,
        });
  };

  const storageValue = storage();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('detail.usage')}</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-2">
        <Metric label={t('usage.messages')} value={count(usage.messages_30d)} />
        <Metric
          label={t('usage.aiReplies')}
          value={count(usage.ai_replies_30d)}
        />
        <Metric label={t('usage.contacts')} value={count(usage.contacts)} />
        {storageValue ? (
          <Metric label={t('usage.storage')} value={storageValue} />
        ) : null}
      </CardContent>
    </Card>
  );
}
