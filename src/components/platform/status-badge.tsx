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
//
// SHAPE. A pill (--altokia-radius-pill) filled with its own colour at
// 14% and lettered in that colour's text-weight variant. Two colours
// per state, not one, because the palette's raw hues are FILLS: amber
// at #F5A524 measures 2.04:1 as small text on white. globals.css
// already mixes each hue per mode into an --altokia-*-text token, so
// the badge asks for the token instead of doing its own arithmetic.
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

/**
 * The text-weight twin of each fill above. Same hue, moved toward
 * black or white by whatever the current mode needs — globals.css
 * measures those mixes, this file must not guess at them.
 */
export const SEMANTIC_SUCCESS_TEXT = 'var(--altokia-success-text, #16C784)';
export const SEMANTIC_WARNING_TEXT = 'var(--altokia-warning-text, #F5A524)';
export const SEMANTIC_DANGER_TEXT = 'var(--altokia-danger-text, #F04455)';
export const BRAND_VIOLET_TEXT = 'var(--altokia-violet-text, #6C4DF6)';

/** The colour that stands for each state, at full strength. */
export const STATUS_COLOR: Record<AccountStatus, string> = {
  trial: BRAND_VIOLET,
  active: SEMANTIC_SUCCESS,
  suspended: SEMANTIC_WARNING,
  cancelled: SEMANTIC_DANGER,
};

/** The same four states, in the weight that can carry words. */
export const STATUS_TEXT_COLOR: Record<AccountStatus, string> = {
  trial: BRAND_VIOLET_TEXT,
  active: SEMANTIC_SUCCESS_TEXT,
  suspended: SEMANTIC_WARNING_TEXT,
  cancelled: SEMANTIC_DANGER_TEXT,
};

/**
 * Kept for callers that hold a raw hue and no token twin: mixing a
 * quarter of the surrounding foreground into a fill pulls it toward
 * whichever end the mode needs. Prefer the `*_TEXT` constants above
 * when the colour is one of the six the brand sheet names.
 */
export function toneText(color: string): string {
  return `color-mix(in oklab, ${color} 76%, var(--foreground))`;
}

/** The badge ground: the colour itself at 14%, over whatever it lands on. */
export function toneTint(color: string): string {
  return `color-mix(in oklab, ${color} 14%, transparent)`;
}

/** Pill geometry shared by both badges on this screen. */
const PILL =
  'h-6 rounded-[var(--altokia-radius-pill)] border-transparent px-2.5 text-[11px] font-semibold';

export function StatusBadge({
  status,
  className,
}: {
  status: AccountStatus;
  className?: string;
}) {
  const t = useTranslations('Platform.status');
  return (
    <Badge
      className={cn(PILL, className)}
      style={{
        backgroundColor: toneTint(STATUS_COLOR[status]),
        color: STATUS_TEXT_COLOR[status],
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
      className={cn(PILL, 'gap-1.5', className)}
      style={{
        backgroundColor: toneTint(SEMANTIC_DANGER),
        color: SEMANTIC_DANGER_TEXT,
      }}
    >
      <Lock size={18} strokeWidth={1.75} />
      {t('noAccess')}
    </Badge>
  );
}
