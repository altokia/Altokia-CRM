'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Archive, ArchiveRestore, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { formatCurrency } from '@/lib/currency';
import { SettingsPanelHead } from './settings-panel-head';

interface AttributeDef {
  id?: string;
  key: string;
  label: string;
  type: 'text' | 'number' | 'boolean' | 'select';
  options: string[];
  position: number;
}

interface CatalogItem {
  id: string;
  name: string;
  category: string | null;
  description: string | null;
  price: number | null;
  currency: string | null;
  availability: 'available' | 'limited' | 'unavailable' | 'on_request';
  stock: number | null;
  features: string[];
  attributes: Record<string, string | number | boolean>;
  status: 'active' | 'archived';
}

const AVAILABILITY = ['available', 'limited', 'unavailable', 'on_request'] as const;
const ATTR_TYPES = ['text', 'number', 'boolean', 'select'] as const;

/**
 * Settings → Catalog.
 *
 * Two things live here: the items themselves, and the attribute
 * vocabulary that makes the catalog fit the business (the academy adds
 * "nivel" and "modalidad", the agency adds "dormitorios" and
 * "distrito"). The item form renders one input per defined attribute,
 * so nobody types free-form JSON and the assistant sees consistent
 * fields.
 */
export function CatalogManager() {
  const t = useTranslations('Settings.catalog');
  const canEdit = useCan('edit-settings');
  const { defaultCurrency } = useAuth();
  const [items, setItems] = useState<CatalogItem[] | null>(null);
  const [defs, setDefs] = useState<AttributeDef[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<CatalogItem | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [itemsRes, defsRes] = await Promise.all([
      fetch(`/api/catalog?status=${showArchived ? 'all' : 'active'}`, { cache: 'no-store' }),
      fetch('/api/catalog/attributes', { cache: 'no-store' }),
    ]);
    const itemsJson = await itemsRes.json().catch(() => ({}));
    const defsJson = await defsRes.json().catch(() => ({}));
    setItems(itemsRes.ok ? (itemsJson.items as CatalogItem[]) : []);
    setDefs(defsRes.ok ? (defsJson.definitions as AttributeDef[]) : []);
  }, [showArchived]);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => {
    if (!items) return [];
    const q = query.trim().toLowerCase();
    return q
      ? items.filter((i) =>
          [i.name, i.category, i.description].some((v) => v?.toLowerCase().includes(q)),
        )
      : items;
  }, [items, query]);

  const toggleArchive = async (item: CatalogItem) => {
    if (item.status === 'active' && !confirm(t('archiveConfirm'))) return;
    setBusy(item.id);
    try {
      const res =
        item.status === 'active'
          ? await fetch(`/api/catalog/${item.id}`, { method: 'DELETE' })
          : await fetch(`/api/catalog/${item.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: 'active' }),
            });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || t('saveError'));
      }
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveError'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          canEdit ? (
            <Button onClick={() => setEditing('new')}>
              <Plus className="size-4" />
              {t('newItem')}
            </Button>
          ) : undefined
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('search')}
          className="max-w-xs"
        />
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Switch checked={showArchived} onCheckedChange={setShowArchived} />
          {t('showArchived')}
        </label>
      </div>

      <Card>
        <CardContent className="p-0">
          {items === null ? (
            <div className="flex justify-center py-10">
              <Loader2 className="size-5 animate-spin text-primary" />
            </div>
          ) : visible.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">{t('empty')}</p>
          ) : (
            <ul className="divide-y divide-border">
              {visible.map((item) => (
                <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-foreground">{item.name}</span>
                      {item.category && (
                        <Badge variant="outline" className="font-normal">
                          {item.category}
                        </Badge>
                      )}
                      {item.status === 'archived' && (
                        <Badge variant="outline" className="font-normal text-muted-foreground">
                          {t('status.archived')}
                        </Badge>
                      )}
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {item.price !== null
                          ? formatCurrency(item.price, item.currency ?? defaultCurrency)
                          : '—'}
                      </span>
                      <span>{t(`availability.${item.availability}`)}</span>
                      {defs.slice(0, 3).map((d) =>
                        item.attributes?.[d.key] !== undefined ? (
                          <span key={d.key}>
                            {d.label}: {String(item.attributes[d.key])}
                          </span>
                        ) : null,
                      )}
                    </div>
                  </div>
                  {canEdit && (
                    <div className="flex gap-1">
                      <Button variant="outline" size="sm" onClick={() => setEditing(item)} disabled={busy === item.id}>
                        <Pencil className="size-3.5" />
                        {t('edit')}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => toggleArchive(item)} disabled={busy === item.id}>
                        {item.status === 'active' ? <Archive className="size-3.5" /> : <ArchiveRestore className="size-3.5" />}
                        {item.status === 'active' ? t('archive') : t('restore')}
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <AttributesEditor defs={defs} canEdit={canEdit} onSaved={load} />

      <ItemDialog
        item={editing}
        defs={defs}
        defaultCurrency={defaultCurrency}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null);
          await load();
        }}
      />
    </section>
  );
}

// ---------------------------------------------------------------------
// Item form
// ---------------------------------------------------------------------

function ItemDialog({
  item,
  defs,
  defaultCurrency,
  onClose,
  onSaved,
}: {
  item: CatalogItem | 'new' | null;
  defs: AttributeDef[];
  defaultCurrency: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const t = useTranslations('Settings.catalog');
  const editing = item && item !== 'new' ? item : null;
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('');
  const [currency, setCurrency] = useState(defaultCurrency);
  const [availability, setAvailability] = useState<CatalogItem['availability']>('available');
  const [stock, setStock] = useState('');
  const [features, setFeatures] = useState('');
  const [attributes, setAttributes] = useState<Record<string, string | number | boolean>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!item) return;
    setName(editing?.name ?? '');
    setCategory(editing?.category ?? '');
    setDescription(editing?.description ?? '');
    setPrice(editing?.price !== null && editing?.price !== undefined ? String(editing.price) : '');
    setCurrency(editing?.currency ?? defaultCurrency);
    setAvailability(editing?.availability ?? 'available');
    setStock(editing?.stock !== null && editing?.stock !== undefined ? String(editing.stock) : '');
    setFeatures((editing?.features ?? []).join('\n'));
    setAttributes(editing?.attributes ?? {});
  }, [item, editing, defaultCurrency]);

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        category: category.trim() || null,
        description: description.trim() || null,
        price: price.trim() === '' ? null : Number(price),
        currency: currency.trim() || null,
        availability,
        stock: stock.trim() === '' ? null : Number(stock),
        features: features.split('\n').map((s) => s.trim()).filter(Boolean),
        attributes,
      };
      const res = editing
        ? await fetch(`/api/catalog/${editing.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
        : await fetch('/api/catalog', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || t('saveError'));
      }
      toast.success(t('saved'));
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveError'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={item !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="bg-popover border-border max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {editing ? t('edit') : t('newItem')}
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="ci-name">{t('fields.name')}</Label>
            <Input id="ci-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="ci-category">{t('fields.category')}</Label>
              <Input id="ci-category" value={category} onChange={(e) => setCategory(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>{t('fields.availability')}</Label>
              <Select value={availability} onValueChange={(v) => v && setAvailability(v as CatalogItem['availability'])}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AVAILABILITY.map((a) => (
                    <SelectItem key={a} value={a}>
                      {t(`availability.${a}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ci-price">{t('fields.price')}</Label>
              <Input id="ci-price" type="number" min={0} step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ci-currency">{t('fields.currency')}</Label>
              <Input id="ci-currency" value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ci-stock">{t('fields.stock')}</Label>
              <Input id="ci-stock" type="number" min={0} step="1" value={stock} onChange={(e) => setStock(e.target.value)} />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ci-desc">{t('fields.description')}</Label>
            <Textarea id="ci-desc" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ci-features">{t('fields.features')}</Label>
            <Textarea id="ci-features" rows={3} value={features} onChange={(e) => setFeatures(e.target.value)} />
          </div>

          {defs.length > 0 && (
            <div className="grid gap-3 rounded-md border border-border p-3">
              <Label>{t('fields.attributes')}</Label>
              {defs.map((d) => (
                <AttributeInput
                  key={d.key}
                  def={d}
                  value={attributes[d.key]}
                  onChange={(v) =>
                    setAttributes((a) => {
                      const next = { ...a };
                      if (v === undefined || v === '') delete next[d.key];
                      else next[d.key] = v;
                      return next;
                    })
                  }
                />
              ))}
            </div>
          )}
        </div>
        <DialogFooter className="bg-popover border-border">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t('cancel')}
          </Button>
          <Button onClick={save} disabled={saving || !name.trim()}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            {t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AttributeInput({
  def,
  value,
  onChange,
}: {
  def: AttributeDef;
  value: string | number | boolean | undefined;
  onChange: (v: string | number | boolean | undefined) => void;
}) {
  const id = `attr-${def.key}`;
  if (def.type === 'boolean') {
    return (
      <div className="flex items-center justify-between">
        <Label htmlFor={id}>{def.label}</Label>
        <Switch id={id} checked={value === true} onCheckedChange={(c) => onChange(c)} />
      </div>
    );
  }
  if (def.type === 'select') {
    return (
      <div className="grid gap-1.5">
        <Label>{def.label}</Label>
        <Select value={value === undefined ? '' : String(value)} onValueChange={(v) => onChange(v || undefined)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {def.options.map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{def.label}</Label>
      <Input
        id={id}
        type={def.type === 'number' ? 'number' : 'text'}
        value={value === undefined ? '' : String(value)}
        onChange={(e) => onChange(def.type === 'number' ? (e.target.value === '' ? undefined : Number(e.target.value)) : e.target.value)}
      />
    </div>
  );
}

// ---------------------------------------------------------------------
// Attribute vocabulary
// ---------------------------------------------------------------------

function AttributesEditor({
  defs,
  canEdit,
  onSaved,
}: {
  defs: AttributeDef[];
  canEdit: boolean;
  onSaved: () => Promise<void>;
}) {
  const t = useTranslations('Settings.catalog.attributes');
  const tc = useTranslations('Settings.catalog');
  const [rows, setRows] = useState<AttributeDef[]>(defs);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setRows(defs);
  }, [defs]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/catalog/attributes', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          definitions: rows.map((r, i) => ({ key: r.key || undefined, label: r.label, type: r.type, options: r.options, position: i })),
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || 'error');
      }
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'error');
    } finally {
      setSaving(false);
    }
  };

  const dirty = JSON.stringify(rows) !== JSON.stringify(defs);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base text-foreground">{t('title')}</CardTitle>
        <p className="text-sm text-muted-foreground">{t('description')}</p>
      </CardHeader>
      <CardContent className="grid gap-3">
        {rows.length === 0 && <p className="text-xs text-muted-foreground">{t('empty')}</p>}
        {rows.map((r, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_140px_1fr_auto] sm:items-end">
            <div className="grid gap-1">
              <Label>{t('label')}</Label>
              <Input value={r.label} disabled={!canEdit} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
            </div>
            <div className="grid gap-1">
              <Label>{t('key')}</Label>
              <Input value={r.key} disabled={!canEdit || !!r.id} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />
            </div>
            <div className="grid gap-1">
              <Label>{t('type')}</Label>
              <Select value={r.type} onValueChange={(v) => v && setRows((rs) => rs.map((x, j) => (j === i ? { ...x, type: v as AttributeDef['type'] } : x)))} disabled={!canEdit}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ATTR_TYPES.map((ty) => (
                    <SelectItem key={ty} value={ty}>
                      {t(`types.${ty}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1">
              <Label>{t('options')}</Label>
              <Input
                value={r.options.join(', ')}
                disabled={!canEdit || r.type !== 'select'}
                onChange={(e) =>
                  setRows((rs) =>
                    rs.map((x, j) =>
                      j === i ? { ...x, options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) } : x,
                    ),
                  )
                }
              />
            </div>
            {canEdit && (
              <Button variant="ghost" size="icon" aria-label={t('remove')} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                <Trash2 className="size-4" />
              </Button>
            )}
          </div>
        ))}
        {canEdit && (
          <div className="flex flex-wrap justify-between gap-2">
            <Button variant="outline" size="sm" onClick={() => setRows((rs) => [...rs, { key: '', label: '', type: 'text', options: [], position: rs.length }])}>
              <Plus className="size-3.5" />
              {t('add')}
            </Button>
            <Button size="sm" onClick={save} disabled={saving || !dirty || rows.some((r) => !r.label.trim())}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              {tc('save')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
