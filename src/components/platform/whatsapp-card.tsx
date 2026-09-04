'use client';

// ============================================================
// Connecting the client's own WhatsApp number.
//
// Altokia does this *for* the client, with credentials the client's
// Meta app issued, which is why the form lives in the console and not
// in the CRM. Two things make it per-client rather than global:
//
//   • app_id / app_secret — Meta signs each event with the App Secret
//     of the app that received it, so one shared secret could only
//     ever validate one customer.
//   • the webhook address — every client gets a distinct one, and
//     pasting the wrong one into Meta silently routes a customer's
//     messages into another customer's account. Hence the copy button
//     and the warning that it differs per client.
//
// Secrets are never echoed back into the form: the access token is
// required on every save because the route requires it, and a token
// pre-filled from the server would be a token leaked to the browser.
//
// The rest of the card is what the customer's own settings page used
// to hold, moved here along with the connection itself: what state the
// number is in, the last thing Meta complained about, an on-demand
// re-check against Meta, and disconnecting. A customer had no business
// doing that last one to themselves — the row carries their webhook
// address, and deleting it out of curiosity took their WhatsApp down
// with no way back except pasting a new address into Meta.
// ============================================================

import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  XCircle,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CopyField } from './copy-field';
import {
  platformFetch,
  platformPut,
  type AccountWhatsapp,
  type WhatsappSaveResponse,
} from './platform-api';
import { usePlatformIdentity } from './use-platform-identity';

/**
 * The detail route sends more about the connection than the shared
 * `AccountWhatsapp` shape promises — the status column, the timestamps
 * and Meta's last complaint. Widened here rather than in platform-api
 * because only this card reads them, and every field stays optional so
 * a route that stops sending one renders nothing rather than a blank.
 */
type WhatsappState = AccountWhatsapp & {
  connected?: boolean | null;
  status?: string | null;
  connected_at?: string | null;
  registered_at?: string | null;
  last_registration_error?: string | null;
};

/** GET /api/whatsapp/config/verify-registration — the staff-only probe. */
interface RegistrationProbe {
  live: boolean;
  checks: Record<string, boolean | null>;
  errors?: string[];
  message?: string;
}

export function WhatsappCard({
  accountId,
  whatsapp,
  onChanged,
}: {
  accountId: string;
  whatsapp: AccountWhatsapp | null;
  onChanged: () => void;
}) {
  const t = useTranslations('Platform');
  const format = useFormatter();
  const identity = usePlatformIdentity();

  const state = whatsapp as WhatsappState | null;

  const [phoneNumberId, setPhoneNumberId] = useState(
    whatsapp?.phone_number_id ?? '',
  );
  const [wabaId, setWabaId] = useState(whatsapp?.waba_id ?? '');
  const [accessToken, setAccessToken] = useState('');
  const [appId, setAppId] = useState(whatsapp?.app_id ?? '');
  const [appSecret, setAppSecret] = useState('');
  const [verifyTokenInput, setVerifyTokenInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<WhatsappSaveResponse | null>(null);
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<RegistrationProbe | null>(null);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const webhookUrl = saved?.webhook_url ?? whatsapp?.webhook_url ?? null;
  const verifyToken = saved?.verify_token ?? whatsapp?.verify_token ?? null;

  // A row exists for this client. Not the same as `connected`: a saved
  // number whose token Meta now refuses is still a connection in the
  // sense that matters here — there is something to check and something
  // to cut.
  const hasConnection = Boolean(state?.phone_number_id);
  const connected = state?.connected === true || state?.status === 'connected';
  const registeredAt = state?.registered_at ?? null;
  const lastError = state?.last_registration_error ?? null;

  // Disconnecting is billing-and-up on the route. Hidden only when we
  // positively know the operator is below that — an unknown role still
  // sees the button and meets the route's own refusal, rather than the
  // console quietly deciding on its behalf.
  const canDisconnect = !(
    identity.state === 'ready' && identity.role === 'support'
  );

  const ready =
    phoneNumberId.trim().length > 0 &&
    wabaId.trim().length > 0 &&
    accessToken.trim().length > 0;

  async function save() {
    if (!ready || saving) return;
    setSaving(true);
    try {
      const data = await platformPut<WhatsappSaveResponse>(
        `/api/platform/accounts/${accountId}/whatsapp`,
        {
          phone_number_id: phoneNumberId.trim(),
          waba_id: wabaId.trim(),
          access_token: accessToken.trim(),
          app_id: appId.trim() || undefined,
          app_secret: appSecret.trim() || undefined,
          verify_token: verifyTokenInput.trim() || undefined,
        },
      );
      setSaved(data);
      setAccessToken('');
      setAppSecret('');
      toast.success(t('whatsapp.saved'));
      onChanged();
    } catch (err) {
      console.error('[platform-console] whatsapp save failed:', err);
      toast.error(err instanceof Error ? err.message : t('errors.generic'));
    } finally {
      setSaving(false);
    }
  }

  // Asks Meta, right now, whether this number is actually wired. Valid
  // credentials are necessary but not sufficient: without the WABA
  // subscription and the /register step Meta accepts the token and
  // delivers nothing, which from the customer's side looks exactly like
  // "the CRM is broken".
  async function verify() {
    if (probing) return;
    setProbing(true);
    try {
      const data = await platformFetch<RegistrationProbe>(
        `/api/whatsapp/config/verify-registration?account_id=${accountId}`,
      );
      setProbe(data);
      if (data.live) toast.success(t('whatsapp.verifyLive'));
      else toast.error(t('whatsapp.verifyNotLive'), { duration: 8000 });
    } catch (err) {
      console.error('[platform-console] whatsapp verify failed:', err);
      toast.error(
        err instanceof Error ? err.message : t('whatsapp.verifyFailed'),
      );
    } finally {
      setProbing(false);
    }
  }

  async function disconnect() {
    if (disconnecting) return;
    setDisconnecting(true);
    try {
      await platformFetch(`/api/platform/accounts/${accountId}/whatsapp`, {
        method: 'DELETE',
      });
      toast.success(t('whatsapp.disconnected'));
      setDisconnectOpen(false);
      setProbe(null);
      // Empty the form too. It was seeded from the row that no longer
      // exists, and leaving the old identifiers sitting in it invites
      // re-saving the very number that was just cut.
      setSaved(null);
      setPhoneNumberId('');
      setWabaId('');
      setAppId('');
      onChanged();
    } catch (err) {
      console.error('[platform-console] whatsapp disconnect failed:', err);
      toast.error(err instanceof Error ? err.message : t('errors.generic'));
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('detail.whatsapp')}</CardTitle>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* What is on file right now. When a client calls to say their
            WhatsApp went quiet, this block plus the probe below is the
            whole answer — and it is the half they used to read for
            themselves before the connection moved to Altokia. */}
        {hasConnection ? (
          <div className="space-y-2.5 rounded-lg bg-card-2 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-sm font-medium">
                {connected ? (
                  <CheckCircle2 className="size-4 text-emerald-500" />
                ) : (
                  <XCircle className="size-4 text-destructive" />
                )}
                {connected
                  ? t('whatsapp.connected')
                  : t('whatsapp.notConnected')}
                {state?.display_phone_number ? (
                  <span className="font-mono text-xs text-muted-foreground">
                    {state.display_phone_number}
                  </span>
                ) : null}
              </span>

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => void verify()}
                  disabled={probing}
                >
                  {probing ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Zap className="size-4" />
                  )}
                  {t('whatsapp.verify')}
                </Button>
                {canDisconnect ? (
                  <Button
                    variant="destructive"
                    onClick={() => setDisconnectOpen(true)}
                  >
                    {t('whatsapp.disconnect')}
                  </Button>
                ) : null}
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              {registeredAt
                ? t('whatsapp.registered', {
                    date: format.dateTime(new Date(registeredAt), {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    }),
                  })
                : t('whatsapp.notRegistered')}
            </p>

            {lastError ? (
              <p className="flex items-start gap-2 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>{t('whatsapp.lastError', { error: lastError })}</span>
              </p>
            ) : null}

            {/* Meta's answer, check by check. The raw key names stay:
                the reader is an operator, and translating them would
                only put distance between this list and the route that
                produced it. */}
            {probe ? (
              <ul className="space-y-1 border-t border-border pt-2.5 text-xs">
                {Object.entries(probe.checks).map(([key, value]) => (
                  <li
                    key={key}
                    className="flex items-center gap-1.5 text-muted-foreground"
                  >
                    {value === true ? (
                      <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" />
                    ) : value === false ? (
                      <XCircle className="size-3.5 shrink-0 text-destructive" />
                    ) : (
                      <span className="size-3.5 shrink-0 rounded-full border border-border" />
                    )}
                    <code>{key}</code>
                  </li>
                ))}
                {(probe.errors ?? []).map((message, index) => (
                  <li key={`error-${index}`} className="text-destructive">
                    {message}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t('whatsapp.nothingConnected')}
          </p>
        )}

        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t('whatsapp.title')}
          </p>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="platform-wa-phone">
                {t('whatsapp.phoneNumberId')}
              </Label>
              <Input
                id="platform-wa-phone"
                value={phoneNumberId}
                autoComplete="off"
                className="font-mono text-xs"
                onChange={(e) => setPhoneNumberId(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="platform-wa-waba">{t('whatsapp.wabaId')}</Label>
              <Input
                id="platform-wa-waba"
                value={wabaId}
                autoComplete="off"
                className="font-mono text-xs"
                onChange={(e) => setWabaId(e.target.value)}
              />
            </div>

            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="platform-wa-token">{t('whatsapp.token')}</Label>
              <Input
                id="platform-wa-token"
                type="password"
                value={accessToken}
                autoComplete="new-password"
                className="font-mono text-xs"
                onChange={(e) => setAccessToken(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="platform-wa-appid">{t('whatsapp.appId')}</Label>
              <Input
                id="platform-wa-appid"
                value={appId}
                autoComplete="off"
                className="font-mono text-xs"
                onChange={(e) => setAppId(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="platform-wa-appsecret">
                {t('whatsapp.appSecret')}
              </Label>
              <Input
                id="platform-wa-appsecret"
                type="password"
                value={appSecret}
                autoComplete="new-password"
                className="font-mono text-xs"
                onChange={(e) => setAppSecret(e.target.value)}
              />
            </div>

            {/* Meta echoes this back on the subscription handshake and
                the webhook compares it, so without it the address can
                never be verified. It used to live on the customer's own
                settings screen; when that screen went, the field went
                with it and connecting a number could not be finished
                from anywhere. */}
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="platform-wa-verify">
                {t('whatsapp.verifyToken')}
              </Label>
              <Input
                id="platform-wa-verify"
                value={verifyTokenInput}
                autoComplete="off"
                className="font-mono text-xs"
                onChange={(e) => setVerifyTokenInput(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t('whatsapp.verifyTokenHint')}
              </p>
            </div>
          </div>

          <Button
            onClick={() => void save()}
            disabled={!ready || saving}
          >
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            {t('actions.save')}
          </Button>
        </div>

        {/* The half the operator has to carry into Meta by hand. Shown
            only once the server has told us what it is. */}
        {webhookUrl ? (
          <div className="space-y-4 rounded-lg bg-card-2 p-4">
            <CopyField
              id="platform-wa-webhook"
              label={t('whatsapp.webhookUrl')}
              value={webhookUrl}
              copyLabel={t('new.copyLink')}
              hint={t('whatsapp.webhookHint')}
            />
            {verifyToken ? (
              <CopyField
                id="platform-wa-verify"
                label={t('whatsapp.verifyToken')}
                value={verifyToken}
                copyLabel={t('new.copyLink')}
              />
            ) : null}
          </div>
        ) : null}
      </CardContent>

      {/* Deleting the row is not a reversible click: it takes the
          number offline and discards the webhook address Meta was
          configured with, so the warning names both before the button
          does anything. */}
      <Dialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('whatsapp.disconnectTitle')}</DialogTitle>
          </DialogHeader>

          <p className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>{t('whatsapp.disconnectWarning')}</span>
          </p>

          <DialogFooter>
            <Button
              variant="outline"
              disabled={disconnecting}
              onClick={() => setDisconnectOpen(false)}
            >
              {t('actions.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={disconnecting}
              onClick={() => void disconnect()}
            >
              {disconnecting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : null}
              {t('whatsapp.disconnectConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
