'use client';

// ============================================================
// /platform/equipo — who at Altokia can touch customer accounts.
//
// Owner-only, and gated twice on purpose: the nav hides the link and
// this screen refuses to render for anyone else, while the routes
// behind it do the real enforcement. A UI gate is a courtesy to the
// operator, never the security boundary.
//
// Removal takes two clicks (the button arms, then commits). No dialog:
// this list is short, the action is reversible by re-adding, and an
// armed button is enough to stop a mis-click during an incident.
//
// DRESS ONLY — the data, its order and the two-click removal are
// exactly what they were. What changed is the surface, and it is
// deliberately the SAME surface as the clients roster: the same
// initials avatar, the same small-caps header, the same 40px control
// height, the same hairline card. The two screens sit one nav item
// apart and an operator moves between them all day.
//
// The operator row carries no email — user_id, role, full_name, note,
// created_at and nothing else — so the mono treatment the mockup puts
// on an address lands here on the identifier and the date instead.
// Nothing was invented to fill a column the data does not have.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Loader2, Plus, ShieldOff, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useIsPlatformOwner } from './use-platform-identity';
import {
  PLATFORM_ROLES,
  platformFetch,
  platformPost,
  type OperatorRow,
  type OperatorsResponse,
  type PlatformRole,
} from './platform-api';

/** The gradient the primary button wears, and nothing else on this screen. */
const BRAND_GRADIENT = 'var(--altokia-gradient)';

/** The console's one primary button, matching the clients roster. */
const PRIMARY_BUTTON =
  'h-10 gap-2 rounded-[var(--altokia-radius-md)] border-transparent px-4 text-sm font-semibold text-altokia-white shadow-altokia hover:opacity-90';

/** The button beside it: surface with a hairline, never a second accent. */
const SECONDARY_BUTTON =
  'h-10 rounded-[var(--altokia-radius-md)] border-border bg-card px-4 text-sm font-medium';

/** Table headers: small caps, wide tracking, soft ink. */
const HEAD =
  'h-10 text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase';

/**
 * Pill geometry, the same one the status badge uses two screens over,
 * so "Dueño" and "Activo" read as the same kind of object.
 */
const PILL =
  'inline-flex h-6 items-center rounded-[var(--altokia-radius-pill)] px-2.5 text-[11px] font-semibold';

/**
 * What each role is worth at a glance. Owner takes the brand violet
 * because it is the role that hands out the other two; billing takes
 * cyan; support is the everyday case and stays neutral, so a team list
 * that is mostly support does not read as a list full of alarms. The
 * semantic three (success, warning, danger) are kept out on purpose:
 * they mean a client's state everywhere else in the console.
 *
 * Text-weight variants only. Raw cyan as 11px type measures 1.73:1 on
 * the light ground; --altokia-cyan-text is the one that carries words.
 */
const ROLE_PILL: Record<PlatformRole, string> = {
  owner: 'bg-altokia-tint text-altokia-violet-lift',
  billing: 'bg-altokia-cyan/[14%] text-altokia-cyan-text',
  support: 'bg-card-2 text-muted-foreground ring-1 ring-border ring-inset',
};

/**
 * The avatar palette, identical to the clients roster: five pairs of
 * the three brand hues and never violet→magenta, which is the brand
 * gradient and belongs to the primary button alone.
 */
const AVATAR_GRADIENTS = [
  'linear-gradient(135deg, var(--altokia-cyan), var(--altokia-violet))',
  'linear-gradient(135deg, var(--altokia-violet), var(--altokia-cyan))',
  'linear-gradient(135deg, var(--altokia-magenta), var(--altokia-cyan))',
  'linear-gradient(135deg, var(--altokia-cyan), var(--altokia-magenta))',
  'linear-gradient(135deg, var(--altokia-magenta), var(--altokia-violet))',
] as const;

/**
 * A pure function of the key, so one teammate wears the same colour in
 * every session. Nothing random, nothing time-based: the compiler lint
 * forbids both in render, and an avatar that reshuffled on each load
 * would be worse than no avatar at all.
 */
function nameHash(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) % 1000003;
  }
  return hash;
}

function avatarGradient(key: string): string {
  return AVATAR_GRADIENTS[nameHash(key) % AVATAR_GRADIENTS.length];
}

/**
 * Two letters: one from each of the first two words, or the first two
 * of a single word. Split by code point, not by index, so a name that
 * starts outside the BMP does not come out as half a character.
 */
function initials(key: string): string {
  const words = key.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const first = [...words[0]];
  const letters =
    words.length > 1
      ? `${first[0] ?? ''}${[...words[1]][0] ?? ''}`
      : first.slice(0, 2).join('');
  return letters.toUpperCase();
}

/** The name if the profile has one, the id if it does not — as the row prints it. */
function avatarKey(operator: OperatorRow): string {
  return operator.full_name?.trim() || operator.user_id;
}

export function OperatorsScreen() {
  const t = useTranslations('Platform');
  const tRoles = useTranslations('Platform.operators.roles');
  const format = useFormatter();
  const isOwner = useIsPlatformOwner();

  const [operators, setOperators] = useState<OperatorRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await platformFetch<OperatorsResponse>(
        '/api/platform/operators',
      );
      setOperators(data.operators ?? []);
      setError(null);
    } catch (err) {
      console.error('[platform-console] operators load failed:', err);
      setOperators([]);
      setError(err instanceof Error ? err.message : null);
    }
  }, []);

  useEffect(() => {
    if (!isOwner) return;
    void load();
  }, [isOwner, load]);

  // The armed delete button disarms itself so it never sits hot.
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(null), 3000);
    return () => clearTimeout(timer);
  }, [armed]);

  async function remove(operator: OperatorRow) {
    if (armed !== operator.user_id) {
      setArmed(operator.user_id);
      return;
    }
    setRemoving(operator.user_id);
    try {
      await platformFetch(`/api/platform/operators/${operator.user_id}`, {
        method: 'DELETE',
      });
      toast.success(t('operators.removed'));
      setArmed(null);
      await load();
    } catch (err) {
      console.error('[platform-console] operator removal failed:', err);
      toast.error(err instanceof Error ? err.message : t('errors.generic'));
    } finally {
      setRemoving(null);
    }
  }

  if (!isOwner) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-4 text-center">
        <span className="flex size-11 items-center justify-center rounded-[var(--altokia-radius-md)] bg-altokia-tint">
          <ShieldOff
            size={18}
            strokeWidth={1.75}
            className="text-altokia-violet-lift"
          />
        </span>
        <p className="text-sm leading-[1.55] text-muted-foreground">
          {t('errors.notOperator')}
        </p>
      </div>
    );
  }

  const list = operators ?? [];

  return (
    <div className="space-y-[var(--altokia-space-3)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="font-heading text-[26px] leading-tight font-bold tracking-tight">
          {t('operators.title')}
        </h1>
        {/* The single brand gesture on the screen. */}
        <Button
          onClick={() => setAddOpen(true)}
          className={PRIMARY_BUTTON}
          style={{ backgroundImage: BRAND_GRADIENT }}
        >
          <Plus size={18} strokeWidth={1.75} className="size-[18px]" />
          {t('operators.add')}
        </Button>
      </div>

      {error ? (
        <div className="rounded-[var(--altokia-radius-lg)] border border-altokia-danger/[35%] bg-altokia-danger/[8%] px-4 py-3.5 text-sm">
          <p className="font-semibold text-altokia-danger-text">
            {t('errors.generic')}
          </p>
          <p className="mt-1 font-mono text-xs break-all text-muted-foreground">
            {error}
          </p>
        </div>
      ) : null}

      {operators === null ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2
            size={18}
            strokeWidth={1.75}
            className="animate-spin text-muted-foreground"
          />
        </div>
      ) : (
        <div className="overflow-hidden rounded-[var(--altokia-radius-lg)] border border-border bg-card shadow-altokia">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-border hover:bg-transparent">
                <TableHead className={cn(HEAD, 'pl-4')}>
                  {t('audit.operator')}
                </TableHead>
                <TableHead className={HEAD}>{t('operators.role')}</TableHead>
                <TableHead className={HEAD}>{t('operators.note')}</TableHead>
                <TableHead className={HEAD}>{t('clients.created')}</TableHead>
                <TableHead className={cn(HEAD, 'pr-4')} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((operator) => (
                <TableRow
                  key={operator.user_id}
                  className="border-b border-border/60 hover:bg-card-2"
                >
                  <TableCell className="py-3.5 pl-4 font-medium">
                    <div className="flex items-center gap-3">
                      {/* Decorative: the two letters are the name that
                          is already spelled out beside them. */}
                      <span
                        aria-hidden="true"
                        className="flex size-[34px] shrink-0 items-center justify-center rounded-[var(--altokia-radius-sm)] text-[12px] font-bold tracking-wide text-altokia-white"
                        style={{
                          backgroundImage: avatarGradient(avatarKey(operator)),
                        }}
                      >
                        {initials(avatarKey(operator))}
                      </span>
                      {operator.full_name ? (
                        <span className="truncate text-sm font-semibold">
                          {operator.full_name}
                        </span>
                      ) : (
                        // No profile name yet: the id is what there is,
                        // and it is an identifier, so it is mono.
                        <span className="font-mono text-xs text-muted-foreground">
                          {operator.user_id}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="py-3.5">
                    <span className={cn(PILL, ROLE_PILL[operator.role])}>
                      {tRoles(operator.role)}
                    </span>
                  </TableCell>
                  <TableCell className="max-w-xs truncate py-3.5 text-sm text-muted-foreground">
                    {operator.note ?? '—'}
                  </TableCell>
                  <TableCell className="py-3.5 font-mono text-xs text-muted-foreground tabular-nums">
                    {format.dateTime(new Date(operator.created_at), {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })}
                  </TableCell>
                  <TableCell className="py-3.5 pr-4 text-right">
                    <Button
                      variant={
                        armed === operator.user_id ? 'destructive' : 'ghost'
                      }
                      size="icon"
                      aria-label={operator.full_name ?? operator.user_id}
                      disabled={removing === operator.user_id}
                      onClick={() => void remove(operator)}
                      className={cn(
                        'size-9 rounded-[var(--altokia-radius-md)]',
                        armed !== operator.user_id && 'text-muted-foreground',
                      )}
                    >
                      {removing === operator.user_id ? (
                        <Loader2
                          size={18}
                          strokeWidth={1.75}
                          className="size-[18px] animate-spin"
                        />
                      ) : (
                        <Trash2
                          size={18}
                          strokeWidth={1.75}
                          className="size-[18px]"
                        />
                      )}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <AddOperatorDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdded={() => void load()}
      />
    </div>
  );
}

// ------------------------------------------------------------

/** Dialog shell: 18px corners, hairline, the pop shadow. */
const DIALOG =
  'gap-[var(--altokia-space-3)] rounded-[var(--altokia-radius-xl)] border border-border p-[var(--altokia-space-3)] shadow-altokia-pop ring-0 sm:max-w-md';

/** Its footer, re-hung on the dialog's own 18px padding. */
const DIALOG_FOOTER =
  'mx-[calc(var(--altokia-space-3)*-1)] mb-[calc(var(--altokia-space-3)*-1)] gap-[var(--altokia-space-1)] rounded-b-[var(--altokia-radius-xl)] border-t border-border bg-card-2 p-[var(--altokia-space-3)]';

/** 11px corners, a hairline, and the console's 40px control height. */
const FIELD =
  'h-10 rounded-[var(--altokia-radius-md)] border-border bg-card-2 px-3.5 text-sm';
const FIELD_LABEL = 'text-[13px] font-medium text-muted-foreground';

function AddOperatorDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
}) {
  const t = useTranslations('Platform');
  const tRoles = useTranslations('Platform.operators.roles');

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<PlatformRole>('support');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setEmail('');
    setRole('support');
    setNote('');
    setSubmitting(false);
  }

  async function submit() {
    const trimmed = email.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      await platformPost('/api/platform/operators', {
        email: trimmed,
        role,
        note: note.trim() || undefined,
      });
      toast.success(t('operators.added'));
      reset();
      onOpenChange(false);
      onAdded();
    } catch (err) {
      console.error('[platform-console] operator add failed:', err);
      toast.error(err instanceof Error ? err.message : t('errors.generic'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className={DIALOG}>
        <DialogHeader>
          <DialogTitle className="font-heading text-[17px] leading-tight font-bold tracking-tight">
            {t('operators.add')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-[var(--altokia-space-3)]">
          <div className="space-y-[var(--altokia-space-1)]">
            <Label htmlFor="platform-operator-email" className={FIELD_LABEL}>
              {t('operators.email')}
            </Label>
            {/* An address is a hard datum: mono, so a slip in the
                domain is visible before the invitation goes out. */}
            <Input
              id="platform-operator-email"
              type="email"
              autoComplete="off"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={cn(FIELD, 'font-mono')}
            />
          </div>

          <div className="space-y-[var(--altokia-space-1)]">
            <Label className={FIELD_LABEL}>{t('operators.role')}</Label>
            <Select
              value={role}
              onValueChange={(v) => v && setRole(v as PlatformRole)}
            >
              <SelectTrigger
                className={cn(FIELD, 'w-full data-[size=default]:h-10')}
              >
                <SelectValue>{tRoles(role)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {PLATFORM_ROLES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {tRoles(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-[var(--altokia-space-1)]">
            <Label htmlFor="platform-operator-note" className={FIELD_LABEL}>
              {t('operators.note')}
            </Label>
            <Textarea
              id="platform-operator-note"
              value={note}
              maxLength={280}
              onChange={(e) => setNote(e.target.value)}
              className={cn(FIELD, 'h-auto min-h-20 py-2.5')}
            />
          </div>
        </div>

        <DialogFooter className={DIALOG_FOOTER}>
          <Button
            variant="outline"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
            disabled={submitting}
            className={SECONDARY_BUTTON}
          >
            {t('actions.cancel')}
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={email.trim().length === 0 || submitting}
            className={PRIMARY_BUTTON}
            style={{ backgroundImage: BRAND_GRADIENT }}
          >
            {submitting ? (
              <Loader2
                size={18}
                strokeWidth={1.75}
                className="size-[18px] animate-spin"
              />
            ) : null}
            {t('operators.add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
