'use client';

// ============================================================
// SupportAccess — Settings → Soporte de Altokia
//
// The customer's side of the support-access handshake. Altokia's
// console files a request (platform_access_grants, migration 045);
// this panel is where the account's admin reads who asked, what for,
// and decides. Approved access is time-boxed by the request itself,
// so it ends on its own — the "Quitar acceso" button is for ending it
// sooner, not for cleaning up.
//
// Below the decisions sits the transparency half: platform_audit_log
// is readable by the affected account's admins, so "did anyone from
// Altokia open my inbox" is a question with an answer on screen.
//
// Nothing here is an error state. No pending request is the normal
// state of a healthy account, and the empty copy is written to read
// that way rather than as a warning.
//
// Everything goes through /api/account/support-access under the
// caller's own session — consent given by the customer, with their
// own identity, is the whole point.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Check, Loader2, ShieldCheck, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { SettingsPanelHead } from './settings-panel-head';

interface Grant {
  id: string;
  operator_user_id: string;
  status: string;
  reason: string;
  requested_at: string;
  granted_at: string | null;
  expires_at: string;
  revoked_at: string | null;
}

interface ActivityEntry {
  id: string;
  operator_user_id: string | null;
  action: string;
  detail: Record<string, unknown> | null;
  created_at: string;
}

interface Payload {
  pending: Grant[];
  active: Grant[];
  activity: ActivityEntry[];
}

type GrantAction = 'approve' | 'deny' | 'revoke';

/**
 * Altokia's staff are not members of this account, so their names
 * live in `platform_operators` — a table only staff may read. The
 * customer gets a stable short reference instead: enough to say
 * "request #a1b2c3d4" on a support call, and honest about being an
 * identifier rather than a person.
 */
function operatorRef(userId: string | null): string {
  return `#${(userId ?? '').slice(0, 8)}`;
}

/** The reason an operator typed, when the audit row carried one. */
function detailReason(detail: Record<string, unknown> | null): string | null {
  const reason = detail?.reason;
  return typeof reason === 'string' && reason.trim() ? reason : null;
}

export function SupportAccess() {
  const t = useTranslations('Settings.support');
  const format = useFormatter();
  // Same gate as the route's `requireRole('admin')`: consent is an
  // admin's call, and RLS would refuse the read for anyone else.
  // `useCan` reads false while the profile is in flight, so the two
  // are distinguished below — otherwise an admin would see the
  // "nothing for you here" view for a frame.
  const { profileLoading } = useAuth();
  const canDecide = useCan('manage-members');

  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/account/support-access', { cache: 'no-store' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        // No translated error copy on purpose: the route's messages
        // are specific ("this request has expired…") and more useful
        // than a generic failure line would be.
        toast.error(payload.error || res.statusText);
        return;
      }
      setData(payload as Payload);
    } catch (err) {
      console.error('[SupportAccess] load error:', err);
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Nothing to fetch until we know the caller is an admin — the
    // route would answer 403, and no state is set synchronously here.
    if (!canDecide) return;
    void load();
  }, [canDecide, load]);

  async function decide(grant: Grant, action: GrantAction) {
    setBusy(grant.id);
    try {
      const res = await fetch('/api/account/support-access', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_id: grant.id, action }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || res.statusText);
        return;
      }
      toast.success(action === 'approve' ? t('approved') : t('revoked'));
      // Refetch rather than patch in place: approving frees the row
      // from the "live request" list and moves it to the active one,
      // and the audit log gains entries we did not write.
      await load();
    } catch (err) {
      console.error('[SupportAccess] decide error:', err);
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  function when(iso: string): string {
    return format.dateTime(new Date(iso), {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  const head = <SettingsPanelHead title={t('title')} description={t('description')} />;

  if (profileLoading || (canDecide && loading)) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        {head}
        <div className="flex items-center justify-center py-12">
          <Loader2 className="text-primary size-6 animate-spin" />
        </div>
      </section>
    );
  }

  // A non-admin still deserves to know the mechanism exists — that is
  // what the description says — but there is nothing here for them to
  // read or decide, and the API would refuse them anyway.
  if (!canDecide) return <section className="animate-in fade-in-50 duration-200">{head}</section>;

  // `data` is only ever set from a successful read, so a null here
  // means the fetch failed — the toast already said so. Falling back
  // to the empty lists would claim "nobody has asked for access",
  // which we do not actually know.
  if (!data) return <section className="animate-in fade-in-50 duration-200">{head}</section>;

  const { pending, active, activity } = data;

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      {head}

      {pending.length === 0 && active.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-10 text-center">
            <ShieldCheck className="text-muted-foreground size-6" />
            <p className="text-muted-foreground mt-2 text-sm">{t('noRequests')}</p>
          </CardContent>
        </Card>
      ) : null}

      {pending.length > 0 ? (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-border divide-y">
              {pending.map((g) => (
                <li
                  key={g.id}
                  className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-foreground text-sm font-medium">
                      {t('pending')}{' '}
                      <span className="text-muted-foreground font-mono text-xs">
                        {operatorRef(g.operator_user_id)}
                      </span>
                    </p>
                    <p className="text-muted-foreground mt-2 text-[11px] font-semibold tracking-[0.08em] uppercase">
                      {t('reason')}
                    </p>
                    <p className="text-foreground mt-0.5 text-sm break-words">{g.reason}</p>
                    <p className="text-muted-foreground mt-1.5 text-xs">
                      {when(g.requested_at)}
                    </p>
                  </div>

                  <div className="flex shrink-0 gap-2 sm:self-center">
                    <Button
                      size="sm"
                      onClick={() => decide(g, 'approve')}
                      disabled={busy === g.id}
                    >
                      {busy === g.id ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Check className="size-4" />
                      )}
                      {t('approve')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => decide(g, 'deny')}
                      disabled={busy === g.id}
                    >
                      <X className="size-4" />
                      {t('deny')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {active.length > 0 ? (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-border divide-y">
              {active.map((g) => (
                <li
                  key={g.id}
                  className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-foreground text-sm font-medium">
                      {t('activeUntil', { until: when(g.expires_at) })}{' '}
                      <span className="text-muted-foreground font-mono text-xs">
                        {operatorRef(g.operator_user_id)}
                      </span>
                    </p>
                    <p className="text-muted-foreground mt-2 text-[11px] font-semibold tracking-[0.08em] uppercase">
                      {t('reason')}
                    </p>
                    <p className="text-foreground mt-0.5 text-sm break-words">{g.reason}</p>
                  </div>

                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => decide(g, 'revoke')}
                    disabled={busy === g.id}
                    className="shrink-0 self-start border-red-500/40 bg-red-500/10 text-red-300 hover:border-red-500/60 hover:bg-red-500/20 hover:text-red-200 sm:self-center"
                  >
                    {busy === g.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <X className="size-4" />
                    )}
                    {t('revoke')}
                  </Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <div>
        <h3 className="text-foreground text-sm font-semibold tracking-tight">{t('history')}</h3>
        <Card className="mt-2">
          {activity.length === 0 ? (
            <CardContent className="py-8 text-center">
              <p className="text-muted-foreground text-sm">{t('historyEmpty')}</p>
            </CardContent>
          ) : (
            <CardContent className="p-0">
              <ul className="divide-border divide-y">
                {activity.map((entry) => {
                  const reason = detailReason(entry.detail);
                  return (
                    <li key={entry.id} className="px-4 py-2.5">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                        {/* The action is a raw verb written by the
                            platform routes (ACCESS_REQUESTED, …). Shown
                            verbatim in mono, like the API-key scopes:
                            it is a record, not UI copy to translate. */}
                        <span className="text-foreground font-mono text-xs">{entry.action}</span>
                        <span className="text-muted-foreground text-xs">
                          {when(entry.created_at)}
                          {' · '}
                          <span className="font-mono">{operatorRef(entry.operator_user_id)}</span>
                        </span>
                      </div>
                      {reason ? (
                        <p className="text-muted-foreground mt-0.5 text-xs break-words">{reason}</p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          )}
        </Card>
      </div>
    </section>
  );
}
