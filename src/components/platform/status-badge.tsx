'use client';

// ============================================================
// The one visual the clients table is scanned for.
//
// Four states, four colours from the Altokia palette, and the same
// four colours are what the filter chips put in their dots — which is
// why the map is exported rather than kept private: a chip whose dot
// disagreed with the badge two columns away would make an operator
// stop trusting both.
//
//   active     success green   — working, nothing to do
//   trial      brand violet    — ours to convert, not a problem
//   suspended  warning amber   — we stopped it, on purpose
//   cancelled  danger red      — gone
//
// Trial is deliberately NOT amber: an operator has to be able to spot
// the accounts somebody actually stopped, and a screen where half the
// rows are warning-coloured hides exactly that.
// ============================================================

import { useTranslations } from 'next-intl';
import { Lock } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { AccountStatus } from './platform-api';

/**
 * The semantic colours, exact values from the brand sheet. Each reads
 * a token first so a palette change in globals.css carries here, and
 * falls back to the literal the brand sheet specifies — the console
 * must render in its own colours even before those tokens exist.
 */
export const SEMANTIC_SUCCESS = 'var(--altokia-success, #16C784)';
export const SEMANTIC_WARNING = 'var(--altokia-warning, #F5A524)';
export const SEMANTIC_DANGER = 'var(--altokia-danger, #F04455)';
export const BRAND_VIOLET = 'var(--altokia-violet, #6C4DF6)';
export const BRAND_CYAN = 'var(--altokia-cyan, #12D8F0)';
export const BRAND_MAGENTA = 'var(--altokia-magenta, #FF2E93)';

/** The colour that stands for each state, at full strength. */
export const STATUS_COLOR: Record<AccountStatus, string> = {
  trial: BRAND_VIOLET,
  active: SEMANTIC_SUCCESS,
  suspended: SEMANTIC_WARNING,
  cancelled: SEMANTIC_DANGER,
};

/**
 * A saturated brand colour is a fill, not a label: #16C784 as text is
 * fine on the ink ground and far too pale on the light one. Mixing a
 * fifth of the surrounding foreground into it pulls the text toward
 * whichever end the mode needs — lighter on dark, darker on light —
 * while the hue, which is the part being read at a glance, is
 * untouched. The tint behind it is the same colour at 16%, which is
 * the brand's own tint recipe.
 */
export function toneText(color: string): string {
  return `color-mix(in oklab, ${color} 76%, var(--foreground))`;
}

export function toneTint(color: string): string {
  return `color-mix(in oklab, ${color} 16%, transparent)`;
}

export function StatusBadge({
  status,
  className,
}: {
  status: AccountStatus;
  className?: string;
}) {
  const t = useTranslations('Platform.status');
  const color = STATUS_COLOR[status];
  return (
    <Badge
      className={cn('rounded-full border-transparent px-2.5', className)}
      style={{
        backgroundColor: toneTint(color),
        color: toneText(color),
      }}
    >
      {t(status)}
    </Badge>
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
      className={cn('gap-1 rounded-full border-transparent px-2.5', className)}
      style={{
        backgroundColor: toneTint(SEMANTIC_DANGER),
        color: toneText(SEMANTIC_DANGER),
      }}
    >
      <Lock />
      {t('noAccess')}
    </Badge>
  );
}
