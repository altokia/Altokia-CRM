'use client';

// ============================================================
// Support access — the one panel on this screen the console cannot
// simply decide.
//
// Reading a client's conversations needs their admin's consent, so
// this is a *request*: it asks for a written reason and a lifetime in
// hours, both of which end up in the client's own audit log. The card
// never shows a "grant" control, because there isn't one to show; the
// only states are none / pending / granted-until.
// ============================================================

import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Clock, Loader2, ShieldCheck, ShieldOff } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  platformPost,
  type AccessRequestResponse,
  type AccountAccess,
} from './platform-api';

const DEFAULT_HOURS = 4;

export function AccessCard({
  accountId,
  access,
  onChanged,
}: {
  accountId: string;
  access: AccountAccess;
  onChanged: () => void;
}) {
  const t = useTranslations('Platform');
  const format = useFormatter();

  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [hours, setHours] = useState(String(DEFAULT_HOURS));
  const [submitting, setSubmitting] = useState(false);

  const hourCount = Number.parseInt(hours, 10);
  const ready =
    reason.trim().length > 0 && Number.isFinite(hourCount) && hourCount > 0;

  async function submit() {
    if (!ready || submitting) return;
    setSubmitting(true);
    try {
      await platformPost<AccessRequestResponse>(
        `/api/platform/accounts/${accountId}/access`,
        { reason: reason.trim(), hours: hourCount },
      );
      toast.success(t('access.requested'));
      setOpen(false);
      setReason('');
      setHours(String(DEFAULT_HOURS));
      onChanged();
    } catch (err) {
      console.error('[platform-console] access request failed:', err);
      toast.error(err instanceof Error ? err.message : t('errors.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('detail.access')}</CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        {access.status === 'granted' ? (
          <p className="flex items-start gap-2 text-sm text-emerald-400">
            <ShieldCheck className="mt-0.5 size-4 shrink-0" />
            <span>
              {t('access.granted', {
                until: access.expires_at
                  ? format.dateTime(new Date(access.expires_at), {
                      day: 'numeric',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                  : '—',
              })}
            </span>
          </p>
        ) : access.status === 'pending' ? (
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <Clock className="mt-0.5 size-4 shrink-0 text-primary" />
            <span>{t('access.pending')}</span>
          </p>
        ) : (
          <>
            <p className="flex items-start gap-2 text-sm text-muted-foreground">
              <ShieldOff className="mt-0.5 size-4 shrink-0" />
              <span>{t('access.none')}</span>
            </p>
            <Button onClick={() => setOpen(true)}>
              {t('actions.requestAccess')}
            </Button>
          </>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('access.request')}</DialogTitle>
            <DialogDescription>{t('access.none')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="platform-access-reason">
                {t('access.reason')}
              </Label>
              <Textarea
                id="platform-access-reason"
                value={reason}
                maxLength={400}
                autoFocus
                placeholder={t('access.reasonPlaceholder')}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="platform-access-hours">{t('access.hours')}</Label>
              <Input
                id="platform-access-hours"
                type="number"
                min={1}
                max={168}
                value={hours}
                className="w-28"
                onChange={(e) => setHours(e.target.value)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={submitting}
            >
              {t('actions.cancel')}
            </Button>
            <Button
              onClick={() => void submit()}
              disabled={!ready || submitting}
            >
              {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('access.request')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
