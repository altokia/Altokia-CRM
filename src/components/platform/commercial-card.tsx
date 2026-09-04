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
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { PlanIncludes, PlanSelect } from './plan-select';
import { StatusBadge } from './status-badge';
import { SuspendDialog } from './suspend-dialog';
import { usePlans } from './use-plans';
import {
  platformPatch,
  type AccountRecord,
  type PlanLimitKey,
} from './platform-api';

export function CommercialCard({
  account,
  usage,
  onChanged,
}: {
  account: AccountRecord;
  /**
   * What this client has actually used, keyed the same way a plan's
   * limits are, so the tier's contents can read "3.000 de 10.000"
   * instead of a ceiling with no context. Partial on purpose: a line
   * the console cannot measure shows the bare limit.
   */
  usage?: Partial<Record<PlanLimitKey, number | null | undefined>>;
  onChanged: () => void;
}) {
  const t = useTranslations('Platform');
  const { selectable, find, loading } = usePlans();

  const [plan, setPlan] = useState<string | null>(account.plan ?? null);
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

  const planChanged = plan !== (account.plan ?? null);
  const dirty = planChanged || notes !== (account.operator_notes ?? '');

  const suspended =
    account.status === 'suspended' || account.status === 'cancelled';

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await platformPatch(`/api/platform/accounts/${account.id}`, {
        // Null clears the tier: since 050 this column is a foreign key
        // to the catalogue, so "" is not a value it can hold.
        plan,
        operator_notes: notes,
      });
      setJustSaved(true);
      // Only the plan gets a toast. Moving a business between tiers
      // changes what they are allowed to do, and the operator should
      // see it land; a note saved is what the button tick is for.
      if (planChanged) toast.success(t('plan.saved'));
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

        <div className="space-y-3">
          <PlanSelect
            id="platform-plan"
            label={t('plan.change')}
            value={plan}
            plans={selectable}
            disabled={loading}
            onChange={setPlan}
          />
          {/* What the tier means, next to the control that changes it —
              the decision is about the ceilings, not the word. */}
          <PlanIncludes
            plan={find(plan)}
            usage={usage}
            className="sm:max-w-xs"
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
