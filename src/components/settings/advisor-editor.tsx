'use client';

import { useCallback, useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ChevronDown, ChevronUp, Loader2, Plus, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCan } from '@/hooks/use-can';
import { cn } from '@/lib/utils';
import { getAdvisors, type AdvisorEntry, type AdvisorsResponse } from '@/components/my-work/api';
import { RoutingSettings } from './routing-settings';

interface WindowRow {
  weekday: number;
  start: string;
  end: string;
}

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0]; // Monday-first display, Sunday last.

/**
 * Settings → Team → "Horarios y asignación".
 *
 * One row per member who can take work: their live status as routing
 * sees it (available / off shift / offline / at capacity…), current
 * load and next shift; admins expand a row to edit department,
 * specialties, capacity, the manual override and the weekly windows.
 * Below the roster, the account-wide routing policy.
 *
 * Reads the same endpoint the queue uses, so what an admin sees here is
 * exactly what the picker would decide.
 */
export function AdvisorEditor() {
  const t = useTranslations('Settings.advisors');
  const [data, setData] = useState<AdvisorsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await getAdvisors());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'error');
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base text-foreground">{t('title')}</CardTitle>
          <p className="text-sm text-muted-foreground">{t('description')}</p>
        </CardHeader>
        <CardContent className="p-0">
          {!data && !error && (
            <div className="flex justify-center py-8">
              <Loader2 className="size-5 animate-spin text-primary" />
            </div>
          )}
          {error && <p className="px-4 py-6 text-sm text-red-500">{error}</p>}
          {data && (
            <ul className="divide-y divide-border">
              {data.advisors.map((a) => (
                <AdvisorRow key={a.user_id} advisor={a} onSaved={load} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      {data && (
        <RoutingSettings timezone={data.timezone} routing={data.routing} onSaved={load} />
      )}
    </div>
  );
}

function AdvisorRow({ advisor, onSaved }: { advisor: AdvisorEntry; onSaved: () => void }) {
  const t = useTranslations('Settings.advisors');
  const format = useFormatter();
  const canEdit = useCan('manage-members');
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const [department, setDepartment] = useState(advisor.profile?.department ?? '');
  const [specialties, setSpecialties] = useState((advisor.profile?.specialties ?? []).join(', '));
  const [capacity, setCapacity] = useState(String(advisor.profile?.capacity ?? 10));
  const [accepts, setAccepts] = useState(advisor.profile?.accepts_assignments ?? true);
  const [override, setOverride] = useState<string>(advisor.profile?.availability_override ?? 'auto');
  const [windows, setWindows] = useState<WindowRow[]>(advisor.schedules);

  // Re-sync when the parent refetches after a save.
  useEffect(() => {
    setDepartment(advisor.profile?.department ?? '');
    setSpecialties((advisor.profile?.specialties ?? []).join(', '));
    setCapacity(String(advisor.profile?.capacity ?? 10));
    setAccepts(advisor.profile?.accepts_assignments ?? true);
    setOverride(advisor.profile?.availability_override ?? 'auto');
    setWindows(advisor.schedules);
  }, [advisor]);

  const statusKey = advisor.availability.available
    ? 'available'
    : (advisor.availability.reasons[0] ?? 'off_shift');

  const save = async () => {
    for (const w of windows) {
      if (w.start >= w.end) {
        toast.error(t('invalidWindow'));
        return;
      }
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/account/advisors/${advisor.user_id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          department: department.trim() || null,
          specialties: specialties
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          capacity: Math.max(0, Number.parseInt(capacity, 10) || 0),
          accepts_assignments: accepts,
          availability_override: override === 'auto' ? null : override,
          schedules: windows,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || t('saveError'));
      }
      toast.success(t('saved'));
      setOpen(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveError'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground">{advisor.full_name || advisor.user_id}</p>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge
              variant="outline"
              className={cn(
                'font-normal',
                advisor.availability.available &&
                  'border-emerald-500/40 text-emerald-600 dark:text-emerald-400',
              )}
            >
              {t(`statusNow.${statusKey}`)}
            </Badge>
            <span>{t('loadLabel', { count: advisor.load })}</span>
            {advisor.next_shift_start && !advisor.availability.onShift && (
              <span>
                {t('nextShift', {
                  time: format.dateTime(new Date(advisor.next_shift_start), {
                    weekday: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  }),
                })}
              </span>
            )}
            {advisor.profile?.department && <span>· {advisor.profile.department}</span>}
          </div>
        </div>
        {canEdit && (
          <Button variant="outline" size="sm" onClick={() => setOpen((o) => !o)}>
            {open ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
            {t('editProfile')}
          </Button>
        )}
      </div>

      {open && canEdit && (
        <div className="mt-4 grid gap-4 rounded-md border border-border bg-muted/30 p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>{t('department')}</Label>
              <Input
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
                placeholder={t('departmentPlaceholder')}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>{t('specialties')}</Label>
              <Input value={specialties} onChange={(e) => setSpecialties(e.target.value)} />
              <p className="text-xs text-muted-foreground">{t('specialtiesHint')}</p>
            </div>
            <div className="grid gap-1.5">
              <Label>{t('capacity')}</Label>
              <Input
                type="number"
                min={0}
                value={capacity}
                onChange={(e) => setCapacity(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>{t('override')}</Label>
              <Select value={override} onValueChange={(v) => v && setOverride(v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{t('overrideAuto')}</SelectItem>
                  <SelectItem value="available">{t('statusNow.available')}</SelectItem>
                  <SelectItem value="busy">{t('statusNow.override_busy')}</SelectItem>
                  <SelectItem value="off">{t('statusNow.override_off')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 sm:col-span-2">
              <span className="text-sm">{t('acceptsAssignments')}</span>
              <Switch checked={accepts} onCheckedChange={setAccepts} />
            </div>
          </div>

          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <Label>{t('schedule')}</Label>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setWindows((w) => [...w, { weekday: 1, start: '09:00', end: '18:00' }])}
              >
                <Plus className="size-3.5" />
                {t('addWindow')}
              </Button>
            </div>
            {windows.length === 0 && (
              <p className="text-xs text-muted-foreground">{t('noSchedule')}</p>
            )}
            {windows.map((w, i) => (
              <div key={i} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-2">
                <Select
                  value={String(w.weekday)}
                  onValueChange={(v) =>
                    v && setWindows((ws) => ws.map((x, j) => (j === i ? { ...x, weekday: Number(v) } : x)))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WEEKDAYS.map((d) => (
                      <SelectItem key={d} value={String(d)}>
                        {t(`weekdays.${d}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  type="time"
                  aria-label={t('from')}
                  value={w.start}
                  onChange={(e) =>
                    setWindows((ws) => ws.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))
                  }
                  className="w-[120px]"
                />
                <Input
                  type="time"
                  aria-label={t('to')}
                  value={w.end}
                  onChange={(e) =>
                    setWindows((ws) => ws.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))
                  }
                  className="w-[120px]"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('removeWindow')}
                  onClick={() => setWindows((ws) => ws.filter((_, j) => j !== i))}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
          </div>

          {/* No separate cancel: the "edit" chevron above collapses the
              panel and discards unsaved edits (state re-syncs on reload). */}
          <div className="flex justify-end">
            <Button onClick={save} disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              {t('save')}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
