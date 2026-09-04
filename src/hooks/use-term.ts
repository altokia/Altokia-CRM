'use client';

import { useCallback, useMemo } from 'react';

import { useAuth } from '@/hooks/use-auth';
import {
  normalizeTerminology,
  type TerminologyKey,
} from '@/lib/terminology';

/**
 * The business's own word for a CRM concept, with the translated word
 * as the fallback.
 *
 * The fallback is not optional and it always comes from next-intl —
 * that's what keeps a screen readable for an account that renamed
 * nothing (the common case) and for the eight concepts an account
 * didn't rename. Never pass a hard-coded Spanish string.
 *
 * Example:
 *   const t = useTranslations('Deals');
 *   const term = useTerm();
 *   <h2>{term('pipeline', t('pipeline'))}</h2>
 *   // "Embudo" by default; "Ruta de venta" if the account renamed it.
 *
 * For an ICU message that interpolates the word, pass it as a value:
 *   t('wonThisMonth', { term: term('won', t('won')) })
 *
 * Safe to call before the profile resolves: the account context is
 * null during that window, so every key falls back to its translation
 * and the words swap in once the overrides land.
 */
export function useTerm(): (key: TerminologyKey, fallback: string) => string {
  const { account } = useAuth();

  // The column is free-form JSONB; normalising here means a stray key
  // or a non-string value can never reach a screen.
  const terminology = useMemo(
    () => normalizeTerminology(account?.terminology),
    [account?.terminology]
  );

  return useCallback(
    (key: TerminologyKey, fallback: string) => terminology[key] || fallback,
    [terminology]
  );
}
