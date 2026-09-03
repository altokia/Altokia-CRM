'use client';

import { useTranslations } from 'next-intl';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

/**
 * The form state for the no-prompt persona. Mirrors the snake_case
 * object the API stores (migration 042) one-to-one, so `toApi` and
 * `fromApi` are just key mapping.
 */
export interface PersonaState {
  name: string;
  role: string;
  language: string;
  region: string;
  formality: 'tu' | 'usted';
  tone: string;
  replyLength: 'short' | 'medium' | 'long';
  emojis: boolean;
  style: string;
  objective: string;
  specialInstructions: string;
}

export const EMPTY_PERSONA: PersonaState = {
  name: '',
  role: '',
  language: 'es',
  region: '',
  formality: 'tu',
  tone: '',
  replyLength: 'short',
  emojis: false,
  style: '',
  objective: '',
  specialInstructions: '',
};

export function personaFromApi(raw: unknown): PersonaState {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const s = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : '');
  return {
    name: s('name'),
    role: s('role'),
    language: s('language') || 'es',
    region: s('region'),
    formality: o.formality === 'usted' ? 'usted' : 'tu',
    tone: s('tone'),
    replyLength:
      o.reply_length === 'medium' || o.reply_length === 'long' ? o.reply_length : 'short',
    emojis: o.emojis === true,
    style: s('style'),
    objective: s('objective'),
    specialInstructions: s('special_instructions'),
  };
}

export function personaToApi(p: PersonaState): Record<string, unknown> {
  return {
    name: p.name,
    role: p.role,
    language: p.language,
    region: p.region,
    formality: p.formality,
    tone: p.tone,
    reply_length: p.replyLength,
    emojis: p.emojis,
    style: p.style,
    objective: p.objective,
    special_instructions: p.specialInstructions,
  };
}

const LANGUAGES = ['es', 'en', 'pt'] as const;

/**
 * "Cómo habla el asistente" — every choice here becomes model
 * instructions through lib/ai/persona.compilePersona. No prompt writing.
 */
export function AiPersonaCard({
  value,
  onChange,
  disabled,
}: {
  value: PersonaState;
  onChange: (next: PersonaState) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('Settings.aiConfig.persona');
  const set = <K extends keyof PersonaState>(k: K, v: PersonaState[K]) => onChange({ ...value, [k]: v });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="persona-name">{t('name')}</Label>
          <Input id="persona-name" value={value.name} onChange={(e) => set('name', e.target.value)} placeholder={t('namePlaceholder')} disabled={disabled} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="persona-role">{t('role')}</Label>
          <Input id="persona-role" value={value.role} onChange={(e) => set('role', e.target.value)} placeholder={t('rolePlaceholder')} disabled={disabled} />
        </div>
        <div className="space-y-2">
          <Label>{t('language')}</Label>
          <Select value={value.language} onValueChange={(v) => v && set('language', v)} disabled={disabled}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LANGUAGES.map((l) => (
                <SelectItem key={l} value={l}>
                  {t(`languages.${l}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="persona-region">{t('region')}</Label>
          <Input id="persona-region" value={value.region} onChange={(e) => set('region', e.target.value)} placeholder={t('regionPlaceholder')} disabled={disabled} />
        </div>
        <div className="space-y-2">
          <Label>{t('formality')}</Label>
          <Select value={value.formality} onValueChange={(v) => v && set('formality', v as PersonaState['formality'])} disabled={disabled}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="tu">{t('formalityTu')}</SelectItem>
              <SelectItem value="usted">{t('formalityUsted')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>{t('replyLength')}</Label>
          <Select value={value.replyLength} onValueChange={(v) => v && set('replyLength', v as PersonaState['replyLength'])} disabled={disabled}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="short">{t('short')}</SelectItem>
              <SelectItem value="medium">{t('medium')}</SelectItem>
              <SelectItem value="long">{t('long')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="persona-tone">{t('tone')}</Label>
          <Input id="persona-tone" value={value.tone} onChange={(e) => set('tone', e.target.value)} placeholder={t('tonePlaceholder')} disabled={disabled} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="persona-style">{t('style')}</Label>
          <Input id="persona-style" value={value.style} onChange={(e) => set('style', e.target.value)} placeholder={t('stylePlaceholder')} disabled={disabled} />
        </div>
        <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 sm:col-span-2">
          <span className="text-sm">{t('emojis')}</span>
          <Switch checked={value.emojis} onCheckedChange={(c) => set('emojis', c)} disabled={disabled} />
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="persona-objective">{t('objective')}</Label>
          <Input id="persona-objective" value={value.objective} onChange={(e) => set('objective', e.target.value)} placeholder={t('objectivePlaceholder')} disabled={disabled} />
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="persona-special">{t('specialInstructions')}</Label>
          <Textarea id="persona-special" rows={3} value={value.specialInstructions} onChange={(e) => set('specialInstructions', e.target.value)} placeholder={t('specialPlaceholder')} disabled={disabled} />
        </div>
      </CardContent>
    </Card>
  );
}
