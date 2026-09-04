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
      <div className="flex h-64 flex-col items-center justify-center gap-3 text-center">
        <ShieldOff className="size-7 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          {t('errors.notOperator')}
        </p>
      </div>
    );
  }

  const list = operators ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">
          {t('operators.title')}
        </h1>
        <Button onClick={() => setAddOpen(true)}>
          <Plus className="size-4" />
          {t('operators.add')}
        </Button>
      </div>

      {error ? (
        <div className="rounded-lg bg-destructive/10 px-4 py-3 text-sm">
          <p className="font-medium text-destructive">{t('errors.generic')}</p>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {error}
          </p>
        </div>
      ) : null}

      {operators === null ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4 text-muted-foreground">
                  {t('audit.operator')}
                </TableHead>
                <TableHead className="text-muted-foreground">
                  {t('operators.role')}
                </TableHead>
                <TableHead className="text-muted-foreground">
                  {t('operators.note')}
                </TableHead>
                <TableHead className="text-muted-foreground">
                  {t('clients.created')}
                </TableHead>
                <TableHead className="pr-4" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((operator) => (
                <TableRow key={operator.user_id}>
                  <TableCell className="pl-4 font-medium">
                    {operator.full_name ?? (
                      <span className="font-mono text-xs text-muted-foreground">
                        {operator.user_id}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {tRoles(operator.role)}
                  </TableCell>
                  <TableCell className="max-w-xs truncate text-muted-foreground">
                    {operator.note ?? '—'}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {format.dateTime(new Date(operator.created_at), {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })}
                  </TableCell>
                  <TableCell className="pr-4 text-right">
                    <Button
                      variant={
                        armed === operator.user_id ? 'destructive' : 'ghost'
                      }
                      size="icon-sm"
                      aria-label={operator.full_name ?? operator.user_id}
                      disabled={removing === operator.user_id}
                      onClick={() => void remove(operator)}
                      className={cn(
                        armed !== operator.user_id && 'text-muted-foreground',
                      )}
                    >
                      {removing === operator.user_id ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Trash2 className="size-4" />
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('operators.add')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="platform-operator-email">
              {t('operators.email')}
            </Label>
            <Input
              id="platform-operator-email"
              type="email"
              autoComplete="off"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label>{t('operators.role')}</Label>
            <Select
              value={role}
              onValueChange={(v) => v && setRole(v as PlatformRole)}
            >
              <SelectTrigger>
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

          <div className="space-y-1.5">
            <Label htmlFor="platform-operator-note">
              {t('operators.note')}
            </Label>
            <Textarea
              id="platform-operator-note"
              value={note}
              maxLength={280}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
            disabled={submitting}
          >
            {t('actions.cancel')}
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={email.trim().length === 0 || submitting}
          >
            {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
            {t('operators.add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
