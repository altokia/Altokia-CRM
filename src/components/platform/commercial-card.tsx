'use client';

// ============================================================
// The commercial half of a client: what they are on, what we have
// written down about them, and whether they are switched on.
//
// Suspending goes through a dialog that demands a reason; reactivating
// does not, because turning a customer's service back on is never the
// action anyone regrets. Saving shows its confirmation on the button
// itself — a toast here would sit on top of the fields just edited.
// ============================================================

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Loader2, Power, PowerOff } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { StatusBadge } from './status-badge';
import { SuspendDialog } from './suspend-dialog';
import { platformPatch, type AccountRecord } from './platform-api';

export function CommercialCard({
  account,
  onChanged,
}: {
  account: AccountRecord;
  onChanged: () => void;
}) {
  const t = useTranslations('Platform');

  const [plan, setPlan] = useState(account.plan ?? '');
  const [notes, setNotes] = useState(account.operator_notes ?? '');
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [reactivating, setReactivating] = useState(false);
  const [suspendOpen, setSuspendOpen] = useState(false);

  useEffect(() => {
    if (!justSaved) return;
    const timer = setTimeout(() => setJustSaved(false), 2000);
    return () => clearTimeout(timer);
  }, [justSaved]);

  const dirty =
    plan !== (account.plan ?? '') || notes !== (account.operator_notes ?? '');

  const suspended =
    account.status === 'suspended' || account.status === 'cancelled';

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await platformPatch(`/api/platform/accounts/${account.id}`, {
        plan: plan.trim(),
        operator_notes: notes,
      });
      setJustSaved(true);
      onChanged();
    } catch (err) {
      console.error('[platform-console] settings save failed:', err);
      toast.error(err instanceof Error ? err.message : t('errors.generic'));
    } finally {
      setSaving(false);
    }
  }

  async function reactivate() {
    if (reactivating) return;
    setReactivating(true);
    try {
      await platformPatch(`/api/platform/accounts/${account.id}`, {
        status: 'active',
      });
      onChanged();
    } catch (err) {
      console.error('[platform-console] reactivate failed:', err);
      toast.error(err instanceof Error ? err.message : t('errors.generic'));
    } finally {
      setReactivating(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('detail.settings')}</CardTitle>
      </CardHeader>

      <CardContent className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-card-2 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">
              {t('clients.status')}
            </span>
            <StatusBadge status={account.status} />
          </div>

          {suspended ? (
            <Button
              variant="outline"
              onClick={() => void reactivate()}
              disabled={reactivating}
            >
              {reactivating ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Power className="size-4" />
              )}
              {t('actions.reactivate')}
            </Button>
          ) : (
            <Button
              variant="destructive"
              onClick={() => setSuspendOpen(true)}
            >
              <PowerOff className="size-4" />
              {t('actions.suspend')}
            </Button>
          )}
        </div>

        {suspended && account.suspended_reason ? (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">
              {t('suspend.reason')}
            </p>
            <p className="text-sm">{account.suspended_reason}</p>
          </div>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor="platform-plan">{t('clients.plan')}</Label>
          <Input
            id="platform-plan"
            value={plan}
            maxLength={60}
            className="sm:max-w-xs"
            onChange={(e) => setPlan(e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          {/* Reuses the roster's "Nota" label: this phase's key list has
              no dedicated string for a client's internal note, and the
              wording is exactly right for it. */}
          <Label htmlFor="platform-notes">{t('operators.note')}</Label>
          <Textarea
            id="platform-notes"
            value={notes}
            maxLength={2000}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <Button onClick={() => void save()} disabled={!dirty || saving}>
          {saving ? (
            <Loader2 className="size-4 animate-spin" />
          ) : justSaved ? (
            <Check className="size-4" />
          ) : null}
          {t('actions.save')}
        </Button>
      </CardContent>

      <SuspendDialog
        open={suspendOpen}
        onOpenChange={setSuspendOpen}
        accountId={account.id}
        accountName={account.name}
        onSuspended={onChanged}
      />
    </Card>
  );
}
