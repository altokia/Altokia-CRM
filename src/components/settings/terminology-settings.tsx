'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, RotateCcw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import {
  normalizeTerminology,
  TERMINOLOGY_KEYS,
  TERM_MAX_LENGTH,
  TERM_MESSAGE_KEYS,
  type TerminologyKey,
} from '@/lib/terminology';
import { SettingsPanelHead } from './settings-panel-head';

type Draft = Record<TerminologyKey, string>;

/** Every key present, empty where the account kept the default word. */
function toDraft(stored: Record<string, string>): Draft {
  return Object.fromEntries(
    TERMINOLOGY_KEYS.map((key) => [key, stored[key] ?? ''] as const)
  ) as Draft;
}

/**
 * Settings → Terminology.
 *
 * The CRM ships one vocabulary; a business rarely uses all of it. An
 * academy enrols instead of winning, a clinic books patients, a real
 * estate agency sells units. Renaming here is display-only — nothing
 * moves in the database — so it stays safe to change at any time.
 *
 * Admins edit; everyone else reads, because the words explain what the
 * rest of the app is showing them.
 */
export function TerminologySettings() {
  const t = useTranslations('Settings.terminology');
  const { account, refreshProfile } = useAuth();
  const canEdit = useCan('manage-members');
  const [saving, setSaving] = useState(false);

  const stored = normalizeTerminology(account?.terminology);
  // normalizeTerminology emits the contract's key order, so serialising
  // gives a signature that changes only when the saved words do — and
  // unlike object identity it survives the account object being rebuilt.
  const signature = JSON.stringify(stored);

  const [draft, setDraft] = useState<Draft>(() => toDraft(stored));

  // Re-seed the form when the context brings new words: the profile
  // arriving on first paint, and the refresh after a save. Adjusting
  // state during render, not in an effect.
  const [seededFrom, setSeededFrom] = useState(signature);
  if (seededFrom !== signature) {
    setSeededFrom(signature);
    setDraft(toDraft(stored));
  }

  const dirty = TERMINOLOGY_KEYS.some(
    (key) => draft[key].trim() !== (stored[key] ?? '')
  );

  const save = async () => {
    setSaving(true);
    try {
      // Send every key, blanks included: the route replaces the whole
      // map, so a cleared field is how an override gets removed.
      const terminology = Object.fromEntries(
        TERMINOLOGY_KEYS.map((key) => [key, draft[key].trim()] as const)
      );
      const res = await fetch('/api/account/terminology', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ terminology }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || t('saveError'));
      }
      toast.success(t('saved'));
      // Every screen reads these words through useTerm(), which reads
      // the auth context — refreshing it lands the rename app-wide
      // without a page reload.
      await refreshProfile();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveError'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      <Card>
        <CardContent className="grid gap-5 sm:grid-cols-2">
          {TERMINOLOGY_KEYS.map((key) => {
            // Stored keys are snake_case, message keys camelCase.
            const message = TERM_MESSAGE_KEYS[key];
            // The default always comes from next-intl, never a literal.
            const fallback = t(`terms.${message}`);
            const value = draft[key];
            return (
              <div key={key} className="grid gap-1.5">
                <Label htmlFor={`term-${key}`}>{fallback}</Label>
                <Input
                  id={`term-${key}`}
                  value={value}
                  placeholder={fallback}
                  maxLength={TERM_MAX_LENGTH}
                  disabled={!canEdit}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, [key]: e.target.value }))
                  }
                />
                <p className="text-xs text-muted-foreground">
                  {t(`hints.${message}`)}
                </p>
                {value.trim() ? (
                  <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                    <span>{t('defaultLabel', { value: fallback })}</span>
                    {canEdit && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-auto px-1.5 py-0.5 text-xs"
                        onClick={() => setDraft((d) => ({ ...d, [key]: '' }))}
                      >
                        <RotateCcw className="size-3" />
                        {t('reset')}
                      </Button>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}

          {canEdit && (
            <div className="flex justify-end sm:col-span-2">
              <Button onClick={save} disabled={saving || !dirty}>
                {saving && <Loader2 className="size-4 animate-spin" />}
                {t('save')}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
