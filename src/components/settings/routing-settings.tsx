'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCan } from '@/hooks/use-can';

const STRATEGIES = [
  'by_schedule',
  'least_load',
  'round_robin',
  'by_department',
  'by_specialty',
  'by_item',
  'previous_advisor',
  'priority',
  'manual',
] as const;
const FALLBACKS = ['queue', 'ai_continue'] as const;

/**
 * How conversations are distributed: the strategy routing applies, what
 * happens when nobody is available, and the time zone every shift is
 * evaluated in. Admins edit; everyone else sees the current values so
 * an agent can understand why a thread landed with them.
 */
export function RoutingSettings({
  timezone,
  routing,
  onSaved,
}: {
  timezone: string;
  routing: { strategy?: string; fallback?: string };
  onSaved: () => void;
}) {
  const t = useTranslations('Settings.advisors');
  const canEdit = useCan('manage-members');
  const [strategy, setStrategy] = useState(routing.strategy ?? 'by_schedule');
  const [fallback, setFallback] = useState(routing.fallback ?? 'queue');
  const [tz, setTz] = useState(timezone);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setStrategy(routing.strategy ?? 'by_schedule');
    setFallback(routing.fallback ?? 'queue');
    setTz(timezone);
  }, [routing.strategy, routing.fallback, timezone]);

  const zones: string[] =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [tz];

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/account/routing', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategy, fallback, timezone: tz }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || t('saveError'));
      }
      toast.success(t('saved'));
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveError'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base text-foreground">{t('routing.title')}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-3">
        <div className="grid gap-1.5">
          <Label>{t('routing.strategy')}</Label>
          <Select value={strategy} onValueChange={(v) => v && setStrategy(v)} disabled={!canEdit}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STRATEGIES.map((s) => (
                <SelectItem key={s} value={s}>
                  {t(`routing.strategies.${s}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label>{t('routing.fallback')}</Label>
          <Select value={fallback} onValueChange={(v) => v && setFallback(v)} disabled={!canEdit}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FALLBACKS.map((f) => (
                <SelectItem key={f} value={f}>
                  {t(`routing.fallbacks.${f}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label>{t('routing.timezone')}</Label>
          <Select value={tz} onValueChange={(v) => v && setTz(v)} disabled={!canEdit}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              {zones.map((z) => (
                <SelectItem key={z} value={z}>
                  {z}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {canEdit && (
          <div className="sm:col-span-3 flex justify-end">
            <Button onClick={save} disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              {t('save')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
