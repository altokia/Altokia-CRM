'use client';

// ============================================================
// The password an operator hands to a customer.
//
// Shown in the clear on purpose. This is not the operator's own
// secret being typed into a login form — it is a credential they are
// about to read out or paste into a message, and hiding it behind
// dots would only mean typing it twice and getting it wrong once.
// The value it holds is dictated by the same rule everywhere: it
// lives in React state for as long as the dialog is open and nowhere
// else. Never localStorage, never the URL, never a log line.
//
// "Generar una segura" is the path we want taken, so it sits next to
// the field rather than under it.
// ============================================================

import { useTranslations } from 'next-intl';
import { Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** Matches Platform.errors.weakPassword, and Supabase's own floor. */
export const MIN_PASSWORD_LENGTH = 10;

const GENERATED_LENGTH = 16;

// No 0/O/1/l/I: these get dictated over the phone and transcribed by
// hand, and an ambiguous glyph turns into a support ticket.
const POOL =
  'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#%*?-_+=';

/** A CSPRNG password. Called from click handlers only, never in render. */
export function generatePassword(length = GENERATED_LENGTH): string {
  const bytes = new Uint32Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += POOL[byte % POOL.length];
  return out;
}

export function PasswordField({
  id,
  value,
  onChange,
  autoFocus,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}) {
  const t = useTranslations('Platform');

  // Silent while empty: an untouched field is not yet a mistake.
  const tooShort = value.length > 0 && value.length < MIN_PASSWORD_LENGTH;

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{t('new.password')}</Label>
      <div className="flex gap-2">
        <Input
          id={id}
          type="text"
          value={value}
          autoFocus={autoFocus}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={72}
          aria-invalid={tooShort || undefined}
          aria-describedby={tooShort ? `${id}-error` : undefined}
          className="font-mono"
          onChange={(e) => onChange(e.target.value)}
        />
        <Button
          type="button"
          variant="outline"
          className="shrink-0"
          onClick={() => onChange(generatePassword())}
        >
          <Sparkles className="size-4" />
          {t('new.generate')}
        </Button>
      </div>
      {tooShort ? (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {t('errors.weakPassword')}
        </p>
      ) : null}
    </div>
  );
}
