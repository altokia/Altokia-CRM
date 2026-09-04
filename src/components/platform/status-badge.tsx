'use client';

// The one visual the clients table is scanned for. Suspended and
// cancelled read as alarm/dead; trial and active read as fine.

import { useTranslations } from 'next-intl';

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
