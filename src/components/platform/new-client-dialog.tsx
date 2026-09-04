'use client';

// ============================================================
// Provisioning a new business.
//
// The dialog has two faces. The first collects what the route needs;
// the second shows the invite link, once. There is no "show it again"
// button because the console genuinely cannot produce one — so the
// panel says out loud what the link is for and who opens it, and the
// only way out is closing the dialog deliberately.
// ============================================================

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
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
import { CopyField } from './copy-field';
import { platformPost, type CreateAccountResponse } from './platform-api';

export function NewClientDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const t = useTranslations('Platform');

  const [name, setName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [plan, setPlan] = useState('');
  const [timezone, setTimezone] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  const ready = name.trim().length > 0 && ownerEmail.trim().length > 0;

  function reset() {
    setName('');
    setOwnerEmail('');
    setPlan('');
    setTimezone('');
    setSubmitting(false);
    setInviteUrl(null);
  }

  async function submit() {
    if (!ready || submitting) return;
    setSubmitting(true);
    try {
      const data = await platformPost<CreateAccountResponse>(
        '/api/platform/accounts',
        {
          name: name.trim(),
          owner_email: ownerEmail.trim(),
          plan: plan.trim() || undefined,
          timezone: timezone.trim() || undefined,
        },
      );
      setInviteUrl(data.invite_url);
      onCreated();
    } catch (err) {
      console.error('[platform-console] create client failed:', err);
      toast.error(err instanceof Error ? err.message : t('errors.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('new.title')}</DialogTitle>
          {inviteUrl ? (
            <DialogDescription>{t('new.done')}</DialogDescription>
          ) : null}
        </DialogHeader>

        {inviteUrl ? (
          <CopyField
            id="platform-invite-url"
            value={inviteUrl}
            copyLabel={t('new.copyLink')}
            hint={t('new.linkHint')}
          />
        ) : (
          <>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="platform-new-name">{t('new.name')}</Label>
                <Input
                  id="platform-new-name"
                  value={name}
                  maxLength={120}
                  autoFocus
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="platform-new-email">
                  {t('new.ownerEmail')}
                </Label>
                <Input
                  id="platform-new-email"
                  type="email"
                  autoComplete="off"
                  value={ownerEmail}
                  onChange={(e) => setOwnerEmail(e.target.value)}
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="platform-new-plan">{t('new.plan')}</Label>
                  <Input
                    id="platform-new-plan"
                    value={plan}
                    maxLength={60}
                    onChange={(e) => setPlan(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="platform-new-tz">{t('new.timezone')}</Label>
                  <Input
                    id="platform-new-tz"
                    value={timezone}
                    maxLength={60}
                    onChange={(e) => setTimezone(e.target.value)}
                  />
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  reset();
                  onOpenChange(false);
                }}
              >
                {t('actions.cancel')}
              </Button>
              <Button
                onClick={() => void submit()}
                disabled={!ready || submitting}
              >
                {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
                {t('new.submit')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
