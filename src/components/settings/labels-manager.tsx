'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, Loader2, Plus, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCan } from '@/hooks/use-can';
import { SettingsPanelHead } from './settings-panel-head';

interface LeadLabel {
  id: string;
  key: string;
  name: string;
  description: string | null;
  color: string;
  position: number;
  is_builtin: boolean;
}

/**
 * Settings → Lead labels.
 *
 * The business's own words for where a customer stands. The assistant
 * classifies into the stable keys; people edit the names, the "when it
 * applies" hint the assistant reads, and the colours. Built-ins can be
 * renamed but not removed; custom ones can be added and deleted.
 */
export function LabelsManager() {
  const t = useTranslations('Settings.labels');
  const canEdit = useCan('edit-settings');
  const [labels, setLabels] = useState<LeadLabel[] | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  const load = useCallback(async () => {
    const res = await fetch('/api/labels', { cache: 'no-store' });
    const json = await res.json().catch(() => ({}));
    setLabels(res.ok ? (json.labels as LeadLabel[]) : []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const patch = async (id: string, body: Partial<LeadLabel>) => {
    setSaving(id);
    try {
      const res = await fetch(`/api/labels/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || t('saveError'));
      }
      toast.success(t('saved'));
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveError'));
    } finally {
      setSaving(null);
    }
  };

  const move = async (index: number, dir: -1 | 1) => {
    if (!labels) return;
    const target = index + dir;
    if (target < 0 || target >= labels.length) return;
    const a = labels[index];
    const b = labels[target];
    // Swap positions; two small PATCHes keep the API simple.
    await patch(a.id, { position: b.position });
    await patch(b.id, { position: a.position });
  };

  const create = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch('/api/labels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim() }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || t('saveError'));
      }
      setNewName('');
      toast.success(t('saved'));
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveError'));
    } finally {
      setCreating(false);
    }
  };

  const remove = async (label: LeadLabel) => {
    if (!confirm(t('deleteConfirm'))) return;
    setSaving(label.id);
    try {
      const res = await fetch(`/api/labels/${label.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || t('saveError'));
      }
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveError'));
    } finally {
      setSaving(null);
    }
  };

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      <Card>
        <CardContent className="p-0">
          {labels === null ? (
            <div className="flex justify-center py-10">
              <Loader2 className="size-5 animate-spin text-primary" />
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {labels.map((label, i) => (
                <LabelRow
                  key={label.id}
                  label={label}
                  canEdit={canEdit}
                  busy={saving === label.id}
                  onSave={(body) => patch(label.id, body)}
                  onMoveUp={i > 0 ? () => move(i, -1) : undefined}
                  onMoveDown={i < labels.length - 1 ? () => move(i, 1) : undefined}
                  onDelete={label.is_builtin ? undefined : () => remove(label)}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {canEdit && (
        <Card>
          <CardContent className="flex flex-wrap items-end gap-3 p-4">
            <div className="grid flex-1 gap-1.5">
              <Label htmlFor="new-label">{t('newLabel')}</Label>
              <Input
                id="new-label"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') create();
                }}
              />
            </div>
            <Button onClick={create} disabled={creating || !newName.trim()}>
              {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              {t('newLabel')}
            </Button>
            <p className="w-full text-xs text-muted-foreground">{t('builtinHint')}</p>
          </CardContent>
        </Card>
      )}
    </section>
  );
}

function LabelRow({
  label,
  canEdit,
  busy,
  onSave,
  onMoveUp,
  onMoveDown,
  onDelete,
}: {
  label: LeadLabel;
  canEdit: boolean;
  busy: boolean;
  onSave: (body: Partial<LeadLabel>) => Promise<void>;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onDelete?: () => void;
}) {
  const t = useTranslations('Settings.labels');
  const [name, setName] = useState(label.name);
  const [description, setDescription] = useState(label.description ?? '');
  const [color, setColor] = useState(label.color);

  // Re-seed the draft when the server row changes (after a save or a
  // reorder) — the "adjust state on prop change" pattern, not an effect.
  const [seededFrom, setSeededFrom] = useState(label);
  if (seededFrom !== label) {
    setSeededFrom(label);
    setName(label.name);
    setDescription(label.description ?? '');
    setColor(label.color);
  }

  const dirty =
    name !== label.name || description !== (label.description ?? '') || color !== label.color;

  return (
    <li className="grid gap-3 px-4 py-3 sm:grid-cols-[auto_1fr_auto] sm:items-start">
      <div className="flex items-center gap-2 pt-2">
        <input
          type="color"
          aria-label={t('color')}
          value={color}
          disabled={!canEdit}
          onChange={(e) => setColor(e.target.value)}
          className="size-7 cursor-pointer rounded border border-border bg-transparent p-0"
        />
        <code className="text-xs text-muted-foreground">{label.key}</code>
        {label.is_builtin && (
          <Badge variant="outline" className="font-normal">
            {t('builtin')}
          </Badge>
        )}
      </div>
      <div className="grid gap-2">
        <Input
          aria-label={t('name')}
          value={name}
          disabled={!canEdit}
          onChange={(e) => setName(e.target.value)}
          className="font-medium"
        />
        <Input
          aria-label={t('when')}
          placeholder={t('when')}
          value={description}
          disabled={!canEdit}
          onChange={(e) => setDescription(e.target.value)}
          className="text-sm"
        />
      </div>
      {canEdit && (
        <div className="flex flex-wrap items-center gap-1">
          <Button variant="ghost" size="icon" aria-label={t('moveUp')} disabled={!onMoveUp || busy} onClick={onMoveUp}>
            <ArrowUp className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" aria-label={t('moveDown')} disabled={!onMoveDown || busy} onClick={onMoveDown}>
            <ArrowDown className="size-4" />
          </Button>
          {onDelete && (
            <Button variant="ghost" size="icon" aria-label={t('delete')} disabled={busy} onClick={onDelete}>
              <Trash2 className="size-4" />
            </Button>
          )}
          <Button
            size="sm"
            disabled={!dirty || busy || !name.trim()}
            onClick={() => onSave({ name: name.trim(), description: description.trim() || null, color })}
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            {t('save')}
          </Button>
        </div>
      )}
    </li>
  );
}
