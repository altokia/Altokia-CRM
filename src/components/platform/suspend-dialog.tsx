'use client';

// Suspending a client stops their messages — inbound and outbound —
// so the dialog refuses to submit without a written reason. The reason
// is not bookkeeping: it lands in the audit log the client can read,
// and it is what an operator quotes back when the client calls to ask
// why their WhatsApp went quiet.
//
// DRESS ONLY: same field, same validation, same call. The one thing
// the dress decides is the colour of the confirming button, and it is
// the error red at full strength rather than the brand gradient.
// Suspending is not something Altokia is proud of; it is something an
// operator does on purpose and should feel the weight of.

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { platformPatch } from './platform-api';

/** Dialog shell: 18px corners, hairline, the pop shadow. */
const DIALOG =
  'gap-[var(--altokia-space-3)] rounded-[var(--altokia-radius-xl)] border border-border p-[var(--altokia-space-3)] shadow-altokia-pop ring-0 sm:max-w-md';

/** Its footer, re-hung on the dialog's own 18px padding. */
const DIALOG_FOOTER =
  'mx-[calc(var(--altokia-space-3)*-1)] mb-[calc(var(--altokia-space-3)*-1)] gap-[var(--altokia-space-1)] rounded-b-[var(--altokia-radius-xl)] border-t border-border bg-card-2 p-[var(--altokia-space-3)]';

const SECONDARY_BUTTON =
  'h-10 rounded-[var(--altokia-radius-md)] border-border bg-card px-4 text-sm font-medium';

/**
 * The same geometry as the console's primary button, in the error
 * colour instead of the brand gradient. Solid, not the tinted default:
 * this is the committing action of the dialog and it should look like
 * one — it just should not look like something we are selling.
 */
const DESTRUCTIVE_BUTTON =
  // Darkened before white sits on it: the raw danger red measures
// 3.70:1 under 14px semibold, and the label of a destructive
// button is the last place to be squinting.
  'h-10 gap-2 rounded-[var(--altokia-radius-md)] border-transparent bg-[color-mix(in_oklab,var(--altokia-danger)_82%,black)] px-4 text-sm font-semibold text-altokia-white shadow-altokia hover:bg-[color-mix(in_oklab,var(--altokia-danger)_72%,black)]';

export function SuspendDialog({
  open,
  onOpenChange,
  accountId,
  accountName,
  onSuspended,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
  accountName: string;
  onSuspended: () => void;
}) {
  const t = useTranslations('Platform');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    const trimmed = reason.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      await platformPatch(`/api/platform/accounts/${accountId}`, {
        status: 'suspended',
        suspended_reason: trimmed,
      });
      toast.success(t('suspend.done'));
      setReason('');
      onOpenChange(false);
      onSuspended();
    } catch (err) {
      console.error('[platform-console] suspend failed:', err);
      toast.error(err instanceof Error ? err.message : t('errors.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setReason('');
        onOpenChange(next);
      }}
    >
      <DialogContent className={DIALOG}>
        <DialogHeader>
          <DialogTitle className="font-heading text-[17px] leading-tight font-bold tracking-tight">
            {t('suspend.title', { name: accountName })}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-[var(--altokia-space-3)]">
          <p className="flex items-start gap-2.5 rounded-[var(--altokia-radius-md)] border border-altokia-danger/[35%] bg-altokia-danger/[8%] px-3.5 py-3 text-sm leading-[1.55] text-altokia-danger-text">
            <AlertTriangle
              size={18}
              strokeWidth={1.75}
              className="mt-px shrink-0"
            />
            <span>{t('suspend.warning')}</span>
          </p>

          <div className="space-y-[var(--altokia-space-1)]">
            <Label
              htmlFor="platform-suspend-reason"
              className="text-[13px] font-medium text-muted-foreground"
            >
              {t('suspend.reason')}
            </Label>
            <Textarea
              id="platform-suspend-reason"
              value={reason}
              maxLength={400}
              autoFocus
              placeholder={t('suspend.reasonPlaceholder')}
              onChange={(e) => setReason(e.target.value)}
              className="min-h-24 rounded-[var(--altokia-radius-md)] border-border bg-card-2 px-3.5 py-2.5 text-sm leading-[1.55]"
            />
          </div>
        </div>

        <DialogFooter className={DIALOG_FOOTER}>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            className={SECONDARY_BUTTON}
          >
            {t('actions.cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={() => void submit()}
            disabled={reason.trim().length === 0 || submitting}
            className={DESTRUCTIVE_BUTTON}
          >
            {submitting ? (
              <Loader2
                size={18}
                strokeWidth={1.75}
                className="size-[18px] animate-spin"
              />
            ) : null}
            {t('suspend.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
