'use client';

// Suspending a client stops their messages — inbound and outbound —
// so the dialog refuses to submit without a written reason. The reason
// is not bookkeeping: it lands in the audit log the client can read,
// and it is what an operator quotes back when the client calls to ask
// why their WhatsApp went quiet.

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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('suspend.title', { name: accountName })}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <p className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>{t('suspend.warning')}</span>
          </p>

          <div className="space-y-1.5">
            <Label htmlFor="platform-suspend-reason">
              {t('suspend.reason')}
            </Label>
            <Textarea
              id="platform-suspend-reason"
              value={reason}
              maxLength={400}
              autoFocus
              placeholder={t('suspend.reasonPlaceholder')}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            {t('actions.cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={() => void submit()}
            disabled={reason.trim().length === 0 || submitting}
          >
            {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
            {t('suspend.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
