'use client';

// The one visual the clients table is scanned for. Suspended and
// cancelled read as alarm/dead; trial and active read as fine.

import { useTranslations } from 'next-intl';
import { Lock } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { AccountStatus } from './platform-api';

const TONE: Record<AccountStatus, string> = {
  trial: 'bg-primary-soft text-primary',
  active: 'bg-emerald-500/15 text-emerald-400',
  suspended: 'bg-destructive/15 text-destructive',
  cancelled: 'bg-muted text-muted-foreground',
};

export function StatusBadge({
  status,
  className,
}: {
  status: AccountStatus;
  className?: string;
}) {
  const t = useTranslations('Platform.status');
  return (
    <Badge className={cn(TONE[status], className)}>{t(status)}</Badge>
  );
}

/**
 * "Nobody here can sign in" — a different fact from the status badge
 * beside it, and the reason they are two badges rather than one. A
 * suspended client still reads their own data; a revoked one cannot
 * get through the door. Renders nothing when access is intact, and
 * nothing at all when the route did not send the field: an absent
 * `access_revoked_at` is unknown, not "fine".
 */
export function AccessBadge({
  revokedAt,
  className,
}: {
  revokedAt?: string | null;
  className?: string;
}) {
  const t = useTranslations('Platform.credentials');
  if (!revokedAt) return null;
  return (
    <Badge
      className={cn('gap-1 bg-destructive/15 text-destructive', className)}
    >
      <Lock />
      {t('noAccess')}
    </Badge>
  );
}
