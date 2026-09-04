'use client';

// ============================================================
// A value the operator has to move somewhere else by hand: the
// one-time invite link, the per-client webhook address, the verify
// token. Always read-only, always copyable, never truncated into
// something that looks complete but isn't.
//
// Confirmation is the icon flipping to a tick rather than a toast:
// these fields sit inside dialogs and cards where a toast would
// cover the very thing being copied.
// ============================================================

import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function CopyField({
  id,
  label,
  value,
  copyLabel,
  hint,
}: {
  id: string;
  label?: string;
  value: string;
  /** Visible text for the copy button — supplied translated. */
  copyLabel: string;
  hint?: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch (err) {
      console.error('[platform-console] clipboard write failed:', err);
    }
  }

  return (
    <div className="space-y-1.5">
      {label ? (
        <Label htmlFor={id} className="text-muted-foreground">
          {label}
        </Label>
      ) : null}
      <div className="flex gap-2">
        <Input
          id={id}
          readOnly
          value={value}
          className="font-mono text-xs"
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button
          type="button"
          variant="outline"
          onClick={copy}
          className="shrink-0"
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          {copyLabel}
        </Button>
      </div>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
