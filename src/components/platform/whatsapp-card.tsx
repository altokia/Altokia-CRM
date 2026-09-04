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
// ============================================================

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CopyField } from './copy-field';
import {
  platformPut,
  type AccountWhatsapp,
  type WhatsappSaveResponse,
} from './platform-api';

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

  const [phoneNumberId, setPhoneNumberId] = useState(
    whatsapp?.phone_number_id ?? '',
  );
  const [wabaId, setWabaId] = useState(whatsapp?.waba_id ?? '');
  const [accessToken, setAccessToken] = useState('');
  const [appId, setAppId] = useState(whatsapp?.app_id ?? '');
  const [appSecret, setAppSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<WhatsappSaveResponse | null>(null);

  const webhookUrl = saved?.webhook_url ?? whatsapp?.webhook_url ?? null;
  const verifyToken = saved?.verify_token ?? whatsapp?.verify_token ?? null;

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

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('detail.whatsapp')}</CardTitle>
      </CardHeader>

      <CardContent className="space-y-5">
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
    </Card>
  );
}
