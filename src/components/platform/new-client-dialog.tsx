'use client';

// ============================================================
// Provisioning a business, cold.
//
// The customer does not sign up. Altokia creates the login, sets the
// password and hands over credentials that already work — so this
// dialog asks for the person as well as the company, and produces a
// working account rather than an invitation to make one.
//
// Two faces. The first collects what the route needs; the second is
// the only time the password is ever visible, which is why the dialog
// says so in as many words instead of letting the operator find out
// later. Closing wipes both faces: the password exists in this
// component's state and nowhere else — not in storage, not in the
// URL, not in the audit log the route writes.
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
import { CredentialsPanel } from './credentials-panel';
import { MIN_PASSWORD_LENGTH, PasswordField } from './password-field';
import { PlanIncludes, PlanSelect } from './plan-select';
import { usePlans } from './use-plans';
import {
  platformPost,
  PlatformRequestError,
  type CreateAccountResponse,
  type IssuedCredentials,
} from './platform-api';

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
  const { selectable, find, loading } = usePlans();

  const [name, setName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [password, setPassword] = useState('');
  const [plan, setPlan] = useState<string | null>(null);
  const [timezone, setTimezone] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [issued, setIssued] = useState<IssuedCredentials | null>(null);

  // An empty password is allowed: the route picks one and returns it,
  // and the panel shows whichever of the two the server settled on.
  const passwordOk =
    password.length === 0 || password.length >= MIN_PASSWORD_LENGTH;
  const ready =
    name.trim().length > 0 && ownerEmail.trim().length > 0 && passwordOk;

  function reset() {
    setName('');
    setOwnerEmail('');
    setOwnerName('');
    setPassword('');
    setPlan(null);
    setTimezone('');
    setSubmitting(false);
    setIssued(null);
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
          owner_name: ownerName.trim() || undefined,
          password: password || undefined,
          plan: plan ?? undefined,
          timezone: timezone.trim() || undefined,
        },
      );

      onCreated();

      if (data.credentials?.password) {
        // Everything the form held goes now; only `issued` survives,
        // and only until the dialog closes.
        setName('');
        setOwnerEmail('');
        setOwnerName('');
        setPassword('');
        setTimezone('');
        setIssued(data.credentials);
      } else {
        // The account exists but the response carried no password to
        // show. Saying nothing would be worse than saying so.
        toast.error(t('errors.generic'));
        reset();
        onOpenChange(false);
      }
    } catch (err) {
      console.error('[platform-console] create client failed:', err);
      const conflict =
        err instanceof PlatformRequestError && err.status === 409;
      toast.error(
        conflict
          ? t('new.emailTaken')
          : err instanceof Error
            ? err.message
            : t('errors.generic'),
      );
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
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('new.title')}</DialogTitle>
          {issued ? (
            <DialogDescription>{t('new.done')}</DialogDescription>
          ) : null}
        </DialogHeader>

        {issued ? (
          <CredentialsPanel
            email={issued.email}
            password={issued.password}
            loginUrl={issued.login_url}
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

              <div className="space-y-1.5">
                <Label htmlFor="platform-new-owner-name">
                  {t('new.ownerName')}
                </Label>
                <Input
                  id="platform-new-owner-name"
                  value={ownerName}
                  maxLength={120}
                  autoComplete="off"
                  onChange={(e) => setOwnerName(e.target.value)}
                />
              </div>

              <PasswordField
                id="platform-new-password"
                value={password}
                onChange={setPassword}
              />

              <PlanSelect
                id="platform-new-plan"
                label={t('new.plan')}
                value={plan}
                plans={selectable}
                disabled={loading}
                onChange={setPlan}
              />

              <PlanIncludes plan={find(plan)} />

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

            <DialogFooter>
              <Button
                variant="outline"
                disabled={submitting}
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
