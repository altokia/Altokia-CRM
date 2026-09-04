'use client';

// ============================================================
// The one time these credentials are ever visible.
//
// Shown after provisioning a client and after resetting their
// password. There is no "show it again" button because there is
// genuinely nothing to show it from: the password reached the browser
// in one response, was never written to any table of ours, and is
// gone from memory when the dialog closes.
//
// One copy button, not three. What the operator actually does next is
// paste the whole block into a WhatsApp message or an email, so the
// clipboard gets the labelled lines — "Entra con: …", "Contraseña: …"
// — rather than a bare value they would have to caption by hand.
// ============================================================

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Check, Copy } from 'lucide-react';

import { Button } from '@/components/ui/button';

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      {/* select-all so a double click grabs the whole value, spaces
          and symbols included, without selecting the label with it. */}
      <p className="font-mono text-sm break-all select-all">{value}</p>
    </div>
  );
}

export function CredentialsPanel({
  email,
  password,
  loginUrl,
}: {
  email: string;
  password: string;
  /** Absent on a password reset — the client already knows the way in. */
  loginUrl?: string | null;
}) {
  const t = useTranslations('Platform');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copyAll() {
    const lines = [
      `${t('credentials.owner')}: ${email}`,
      `${t('new.password')}: ${password}`,
    ];
    if (loginUrl) lines.push(`${t('new.loginUrl')}: ${loginUrl}`);

    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
    } catch (err) {
      console.error('[platform-console] clipboard write failed:', err);
    }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-3 rounded-lg bg-card-2 px-3 py-3">
        <p className="text-xs font-medium text-muted-foreground">
          {t('new.credentials')}
        </p>
        <Line label={t('credentials.owner')} value={email} />
        <Line label={t('new.password')} value={password} />
        {loginUrl ? (
          <Line label={t('new.loginUrl')} value={loginUrl} />
        ) : null}
      </div>

      <Button type="button" className="w-full" onClick={() => void copyAll()}>
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        {t('new.copyAll')}
      </Button>

      <p className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <span>{t('new.warning')}</span>
      </p>
    </div>
  );
}
