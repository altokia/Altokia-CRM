'use client';

// ============================================================
// /join/[token] — invitation redemption landing page.
//
// Four UI states driven by:
//   - the peek result (server-validated invite payload), and
//   - whether the visitor is currently authenticated.
//
//   ┌──────────────────────┬───────────────┬─────────────────────────┐
//   │ peek                 │ auth          │ render                   │
//   ├──────────────────────┼───────────────┼─────────────────────────┤
//   │ loading              │ —             │ spinner                  │
//   │ ok:false (any reason)│ —             │ friendly error + sign in │
//   │ ok:true              │ signed out    │ "Sign in" + where a      │
//   │                      │               │ login comes from         │
//   │ ok:true              │ signed in     │ "Accept" button → redeem │
//   └──────────────────────┴───────────────┴─────────────────────────┘
//
// Every dead end here used to offer "create an account". That door is
// closed: nobody self-registers in this product — Altokia creates each
// login from the operator console and hands over the credentials — so
// the signed-out visitor gets one action (sign in) plus a line saying
// where a login comes from if they don't have one yet. The invitation
// itself is unchanged: it still moves an existing login into the
// inviting account.
//
// We deliberately do NOT redeem automatically on page load — the
// invitee should confirm what account/role they're accepting.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  AlertTriangle,
  CheckCircle,
  Loader2,
  MailX,
  ShieldCheck,
  UsersRound,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { createClient } from '@/lib/supabase/client';

interface PeekOk {
  ok: true;
  account_name: string;
  role: 'admin' | 'agent' | 'viewer';
  expires_at: string;
}
interface PeekFail {
  ok: false;
  reason: 'not_found' | 'used' | 'expired' | 'server_error';
}
type PeekResult = PeekOk | PeekFail;

export default function JoinPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token;
  // Copy moved into the catalogue with the signup removal: this page is
  // the one product screen a customer's employee sees before they have
  // ever signed in, and it was the last one still hardcoded in English.
  const t = useTranslations('JoinPage');

  const [peek, setPeek] = useState<PeekResult | null>(null);
  // Local auth probe — the AuthProvider lives inside the (dashboard)
  // route group, so it doesn't reach this page. We hit Supabase
  // directly the same way `/login` does.
  const [authedUserId, setAuthedUserId] = useState<string | null | undefined>(
    undefined, // undefined = unknown / still loading; null = signed out
  );
  const [accepting, setAccepting] = useState(false);
  // `redeem_invitation` returns 409 when the caller's current account
  // has domain data, or they're already a member of a shared account.
  // A transient toast wasn't enough — the user has no actionable next
  // step. Surface a blocking modal that walks them through it.
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  // Extracted so the "Try again" button on the server_error card
  // can re-run the same logic without remounting the component.
  const loadPeekAndAuth = useCallback(async () => {
    if (!token) return;
    setPeek(null);
    setAuthedUserId(undefined);
    try {
      const [peekRes, authRes] = await Promise.all([
        fetch(`/api/invitations/${encodeURIComponent(token)}/peek`, {
          cache: 'no-store',
        }),
        createClient().auth.getUser(),
      ]);
      const peekBody = (await peekRes.json()) as PeekResult;
      setPeek(peekBody);
      setAuthedUserId(authRes.data.user?.id ?? null);
    } catch (err) {
      console.error('[join] peek error:', err);
      setPeek({ ok: false, reason: 'server_error' });
      setAuthedUserId(null);
    }
  }, [token]);

  // Fetch peek + auth state on mount. The peek endpoint is
  // rate-limited per-IP (30/min) so double-mounting in React 19
  // strict mode dev is harmless. We also use the `cancelled` flag
  // to drop setState calls if the component unmounts mid-fetch.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const [peekRes, authRes] = await Promise.all([
          fetch(`/api/invitations/${encodeURIComponent(token)}/peek`, {
            cache: 'no-store',
          }),
          createClient().auth.getUser(),
        ]);
        const peekBody = (await peekRes.json()) as PeekResult;
        if (cancelled) return;
        setPeek(peekBody);
        setAuthedUserId(authRes.data.user?.id ?? null);
      } catch (err) {
        console.error('[join] peek error:', err);
        if (cancelled) return;
        setPeek({ ok: false, reason: 'server_error' });
        setAuthedUserId(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleAccept = useCallback(async () => {
    if (!token) return;
    setAccepting(true);
    try {
      const res = await fetch(
        `/api/invitations/${encodeURIComponent(token)}/redeem`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        // 409 = caller already has data / is in another shared
        // account. The redeem RPC's error message is descriptive
        // enough to show directly; we open a modal so the user has
        // a clear next-action (sign out → use their other login)
        // rather than a 3-second toast.
        if (res.status === 409) {
          setConflictMessage(payload.error || t('conflict.fallback'));
        } else {
          toast.error(payload.error || t('toast.acceptFailed'));
        }
        setAccepting(false);
        return;
      }
      toast.success(t('toast.welcome'));
      // Full reload (not router.push) so AuthProvider re-fetches
      // the profile with the new account_id and account_role.
      window.location.href = '/dashboard';
    } catch (err) {
      console.error('[join] redeem error:', err);
      toast.error(t('toast.network'));
      setAccepting(false);
    }
  }, [token, t]);

  const handleSignOutAndRetry = useCallback(async () => {
    setSigningOut(true);
    try {
      await createClient().auth.signOut();
      // Hard reload so the new auth state propagates everywhere
      // (middleware, AuthProvider). Preserves the invite token in
      // the URL so the rebuilt page renders the signed-out CTA path.
      window.location.reload();
    } catch (err) {
      console.error('[join] sign-out error:', err);
      toast.error(t('toast.signOutFailed'));
      setSigningOut(false);
    }
  }, [t]);

  // ----- Loading state (peek pending OR auth not yet resolved) -----
  if (peek === null || authedUserId === undefined) {
    return (
      <Card className="w-full max-w-md border-border bg-card">
        <CardContent className="flex flex-col items-center gap-3 py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">{t('verifying')}</p>
        </CardContent>
      </Card>
    );
  }

  // ----- Peek failed -----
  if (!peek.ok) {
    return (
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-red-500/10">
            <MailX className="h-6 w-6 text-red-400" />
          </div>
          <CardTitle className="text-xl text-foreground">
            {t(`fail.${peek.reason}.title`)}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t(`fail.${peek.reason}.body`)}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {/* For server_error the failure is transient — the network
              flapped or the peek endpoint hiccupped. Try-again is the
              right primary action, with sign-in as the secondary escape
              hatch. The other reasons (not_found / used / expired) are
              terminal for this token, so signing in is all that is left
              to offer: a replacement invite can only come from the admin
              who issued this one. */}
          {peek.reason === 'server_error' ? (
            <>
              <Button
                onClick={loadPeekAndAuth}
                className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {t('tryAgain')}
              </Button>
              <Link href="/login">
                <Button
                  variant="outline"
                  className="w-full border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  {t('signIn')}
                </Button>
              </Link>
            </>
          ) : (
            <Link href="/login">
              <Button className="w-full bg-primary text-primary-foreground hover:bg-primary/90">
                {t('signIn')}
              </Button>
            </Link>
          )}
        </CardContent>
      </Card>
    );
  }

  // ----- Peek OK -----
  const inviteHeader = (
    <CardHeader className="items-center text-center">
      <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
        <UsersRound className="h-6 w-6 text-primary" />
      </div>
      <CardTitle className="text-xl text-foreground">
        {t('invitedTo')} <span className="text-primary">{peek.account_name}</span>
      </CardTitle>
      <CardDescription className="text-muted-foreground">
        {t('joinAs')}{' '}
        <span className="inline-flex items-center gap-1 text-foreground">
          <ShieldCheck className="size-3.5 text-primary" />
          {t(`roles.${peek.role}`)}
        </span>
        {'. '}
        {t('validUntil', {
          date: new Date(peek.expires_at).toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
          }),
        })}
      </CardDescription>
    </CardHeader>
  );

  // ----- Authed: show Accept button -----
  if (authedUserId) {
    return (
      <>
        <Card className="w-full max-w-md border-border bg-card">
          {inviteHeader}
          <CardContent className="flex flex-col gap-3">
            <Button
              onClick={handleAccept}
              disabled={accepting}
              className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {accepting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('accepting')}
                </>
              ) : (
                <>
                  <CheckCircle className="size-4" />
                  {t('accept')}
                </>
              )}
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              {t('acceptNote', { account: peek.account_name })}
            </p>
          </CardContent>
        </Card>

        {/* Conflict modal — opens when the redeem endpoint returns 409
            (caller already in a shared account or has domain data).
            Blocks the flow until the user picks a recovery action so
            they aren't stuck retrying an inevitable failure. */}
        <Dialog
          open={conflictMessage !== null}
          onOpenChange={(open) => {
            if (!open) setConflictMessage(null);
          }}
        >
          <DialogContent className="bg-popover border-border sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-popover-foreground">
                <AlertTriangle className="size-4 text-amber-400" />
                {t('conflict.title', { account: peek.account_name })}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {conflictMessage}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2 py-2 text-xs text-muted-foreground">
              {/* This used to end with "sign up again with a different
                  email". There is no signing up any more, so the way out
                  is the other login the person already holds — or one
                  Altokia issues them. */}
              <p>{t('conflict.help', { account: peek.account_name })}</p>
            </div>
            <DialogFooter className="bg-popover border-border">
              <Button
                variant="outline"
                onClick={() => setConflictMessage(null)}
                className="border-border text-popover-foreground hover:bg-muted"
              >
                {t('conflict.stay')}
              </Button>
              <Button
                onClick={handleSignOutAndRetry}
                disabled={signingOut}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {signingOut ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t('conflict.signingOut')}
                  </>
                ) : (
                  t('conflict.switch')
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  // ----- Not authed: sign in, or learn where a login comes from -----
  //
  // Someone who already has a login is one click from joining. Someone
  // who has none cannot make one — the project refuses signups — so
  // instead of a button leading to a form that always fails, they get
  // the real instruction: ask Altokia for the credentials, then return
  // to this same link, which stays valid until it expires.
  return (
    <Card className="w-full max-w-md border-border bg-card">
      {inviteHeader}
      <CardContent className="flex flex-col gap-3">
        <Link href={`/login?invite=${encodeURIComponent(token!)}`}>
          <Button className="w-full bg-primary text-primary-foreground hover:bg-primary/90">
            {t('signInToJoin')}
          </Button>
        </Link>
        <p className="text-center text-xs text-muted-foreground">
          {t('noLoginYet')}
        </p>
      </CardContent>
    </Card>
  );
}
