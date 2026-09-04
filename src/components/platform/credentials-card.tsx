'use client';

// ============================================================
// Who can get into this client, and Altokia's grip on it.
//
// Deliberately NOT the same card as support access. That one is a
// request the customer has to approve; this one is the key to their
// front door, which Altokia cut and Altokia can take back. The two
// sit on the same screen, so each has to say plainly which it is.
//
// Revoking is not suspending, and the card never lets the two blur:
// suspension is commercial and leaves the customer reading their own
// data, revocation means nobody at that company can sign in at all.
// Hence the reason box and the warning that names the consequence
// before the button does anything.
//
// The card is invisible to operators the routes would refuse anyway
// (credentials are billing-and-up): a 403 or 404 renders nothing
// rather than a card whose every button errors.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import {
  AlertTriangle,
  KeyRound,
  Loader2,
  Lock,
  ShieldCheck,
  Undo2,
  UserCircle,
  Users,
} from 'lucide-react';
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
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { CredentialsPanel } from './credentials-panel';
import { MIN_PASSWORD_LENGTH, PasswordField } from './password-field';
import {
  platformFetch,
  platformPost,
  platformPut,
  PlatformRequestError,
  type AccessChangeResponse,
  type AccountCredentials,
  type PasswordResetResponse,
} from './platform-api';

export function CredentialsCard({
  accountId,
  accountName,
  onChanged,
}: {
  accountId: string;
  accountName: string;
  /** Revoking also moves the account record the rest of the page reads. */
  onChanged: () => void;
}) {
  const t = useTranslations('Platform');
  const format = useFormatter();

  const [data, setData] = useState<AccountCredentials | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const load = useCallback(async () => {
    try {
      const payload = await platformFetch<AccountCredentials>(
        `/api/platform/accounts/${accountId}/credentials`,
      );
      setData(payload);
      setError(null);
    } catch (err) {
      // 403: an operator below billing. 404: the access layer refusing
      // to admit the route exists. Either way there is nothing here
      // for this person to use.
      if (
        err instanceof PlatformRequestError &&
        (err.status === 403 || err.status === 404)
      ) {
        setHidden(true);
        return;
      }
      console.error('[platform-console] credentials load failed:', err);
      setError(err instanceof Error ? err.message : null);
    }
  }, [accountId]);

  useEffect(() => {
    // `load` awaits before it writes state, so the effect body itself
    // sets nothing.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const refresh = useCallback(() => {
    void load();
    onChanged();
  }, [load, onChanged]);

  async function restore() {
    if (restoring) return;
    setRestoring(true);
    try {
      await platformPost<AccessChangeResponse>(
        `/api/platform/accounts/${accountId}/credentials`,
        { action: 'restore' },
      );
      toast.success(t('credentials.restored'));
      refresh();
    } catch (err) {
      console.error('[platform-console] access restore failed:', err);
      toast.error(err instanceof Error ? err.message : t('errors.generic'));
    } finally {
      setRestoring(false);
    }
  }

  if (hidden) return null;

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('credentials.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-destructive">{t('errors.generic')}</p>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {error}
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('credentials.title')}</CardTitle>
        </CardHeader>
        <CardContent className="flex h-24 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  const revoked = Boolean(data.access_revoked_at);
  const email = data.owner_email ?? '—';

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('credentials.title')}</CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="space-y-2">
          <div className="flex items-start gap-2">
            <UserCircle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">
                {t('credentials.owner')}
              </p>
              <p className="font-mono text-sm break-all select-all">{email}</p>
            </div>
          </div>

          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            {data.issued_by_altokia ? (
              <>
                <ShieldCheck className="mt-0.5 size-4 shrink-0" />
                <span>
                  {t('credentials.issuedByUs', {
                    date: data.credentials_issued_at
                      ? format.dateTime(new Date(data.credentials_issued_at), {
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric',
                        })
                      : '—',
                  })}
                </span>
              </>
            ) : (
              <>
                <UserCircle className="mt-0.5 size-4 shrink-0" />
                <span>{t('credentials.selfSignup')}</span>
              </>
            )}
          </p>

          {typeof data.member_count === 'number' ? (
            <p className="flex items-start gap-2 text-sm text-muted-foreground">
              <Users className="mt-0.5 size-4 shrink-0" />
              <span>{t('credentials.members', { count: data.member_count })}</span>
            </p>
          ) : null}
        </div>

        {revoked ? (
          <div className="space-y-3 rounded-lg bg-destructive/10 px-3 py-2.5">
            <p className="flex items-start gap-2 text-sm font-medium text-destructive">
              <Lock className="mt-0.5 size-4 shrink-0" />
              <span>
                {t('credentials.revoked', {
                  date: data.access_revoked_at
                    ? format.dateTime(new Date(data.access_revoked_at), {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })
                    : '—',
                })}
              </span>
            </p>

            {data.access_revoked_reason ? (
              <p className="text-sm text-muted-foreground">
                {t('credentials.revokedBecause', {
                  reason: data.access_revoked_reason,
                })}
              </p>
            ) : null}

            <Button
              variant="outline"
              disabled={restoring}
              onClick={() => void restore()}
            >
              {restoring ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Undo2 className="size-4" />
              )}
              {t('credentials.restore')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setResetOpen(true)}>
              <KeyRound className="size-4" />
              {t('credentials.reset')}
            </Button>
            <Button variant="destructive" onClick={() => setRevokeOpen(true)}>
              <Lock className="size-4" />
              {t('credentials.revoke')}
            </Button>
          </div>
        )}
      </CardContent>

      <ResetPasswordDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        accountId={accountId}
        email={email}
        onChanged={refresh}
      />

      <RevokeAccessDialog
        open={revokeOpen}
        onOpenChange={setRevokeOpen}
        accountId={accountId}
        accountName={accountName}
        onChanged={refresh}
      />
    </Card>
  );
}

// ------------------------------------------------------------

function ResetPasswordDialog({
  open,
  onOpenChange,
  accountId,
  email,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
  email: string;
  onChanged: () => void;
}) {
  const t = useTranslations('Platform');

  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [issued, setIssued] = useState<PasswordResetResponse | null>(null);

  const ready =
    password.length === 0 || password.length >= MIN_PASSWORD_LENGTH;

  function reset() {
    setPassword('');
    setSubmitting(false);
    setIssued(null);
  }

  async function submit() {
    if (!ready || submitting) return;
    setSubmitting(true);
    try {
      const data = await platformPut<PasswordResetResponse>(
        `/api/platform/accounts/${accountId}/credentials`,
        { password: password || undefined },
      );
      onChanged();

      if (data.password) {
        // The typed value is dropped the moment the server has it;
        // what stays on screen is the response, and only until close.
        setPassword('');
        setIssued(data);
      } else {
        toast.error(t('errors.generic'));
        reset();
        onOpenChange(false);
      }
    } catch (err) {
      console.error('[platform-console] password reset failed:', err);
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
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('credentials.resetTitle', { email })}</DialogTitle>
          {issued ? (
            <DialogDescription>{t('credentials.resetDone')}</DialogDescription>
          ) : null}
        </DialogHeader>

        {issued ? (
          <CredentialsPanel email={issued.email} password={issued.password} />
        ) : (
          <>
            <div className="space-y-4">
              <p className="flex items-start gap-2 rounded-lg bg-card-2 px-3 py-2.5 text-sm text-muted-foreground">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>{t('credentials.resetWarning')}</span>
              </p>

              <PasswordField
                id="platform-reset-password"
                value={password}
                onChange={setPassword}
                autoFocus
              />
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                disabled={submitting}
                onClick={() => onOpenChange(false)}
              >
                {t('actions.cancel')}
              </Button>
              <Button
                onClick={() => void submit()}
                disabled={!ready || submitting}
              >
                {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
                {t('credentials.reset')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------

function RevokeAccessDialog({
  open,
  onOpenChange,
  accountId,
  accountName,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
  accountName: string;
  onChanged: () => void;
}) {
  const t = useTranslations('Platform');

  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    const trimmed = reason.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      await platformPost<AccessChangeResponse>(
        `/api/platform/accounts/${accountId}/credentials`,
        { action: 'revoke', reason: trimmed },
      );
      setReason('');
      onOpenChange(false);
      onChanged();
    } catch (err) {
      console.error('[platform-console] access revoke failed:', err);
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
          <DialogTitle>
            {t('credentials.revokeTitle', { name: accountName })}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <p className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>{t('credentials.revokeWarning')}</span>
          </p>

          <div className="space-y-1.5">
            <Label htmlFor="platform-revoke-reason">
              {t('credentials.revokeReason')}
            </Label>
            <Textarea
              id="platform-revoke-reason"
              value={reason}
              maxLength={400}
              autoFocus
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
          >
            {t('actions.cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={reason.trim().length === 0 || submitting}
            onClick={() => void submit()}
          >
            {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
            {t('credentials.revoke')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
