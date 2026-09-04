'use client';

// ============================================================
// The Altokia console shell.
//
// This is a different product from the CRM, for a different person,
// and the surest way to cause an expensive mistake is to let an
// operator forget which of the two they are looking at. So the console
// does not reuse the CRM's shell, and it does not inherit the CRM's
// theme either: it pins its own palette — a slate-navy ground with an
// amber accent — regardless of the accent and light/dark mode the
// signed-in person picked for their CRM.
//
// Pinning it takes two mechanisms, on purpose:
//
//   1. Inline custom properties on the shell root cover everything
//      rendered inside it.
//   2. A `body:has([data-plane="platform"])` rule covers what escapes
//      that subtree — Base UI portals its dialogs and select popups
//      onto document.body, and a violet dialog floating over an amber
//      console would undo the whole point.
//
// The rule sits at the same specificity as globals.css's
// `html[data-mode="…"]` block but appears later in the document (an
// inline <style> in the body, vs. a <link> in the head), so it wins.
// If a browser lacks :has(), mechanism 1 still holds the page itself.
// ============================================================

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Building2, ScrollText, ShieldOff, Users2, type LucideIcon } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';

import { cn } from '@/lib/utils';
import {
  PlatformIdentityProvider,
  usePlatformIdentityValue,
} from './use-platform-identity';

// Single source of truth for the console palette: the object feeds the
// inline style, the string feeds the portal-covering rule.
const CONSOLE_TOKENS: Record<string, string> = {
  '--background': 'oklch(0.205 0.028 258)',
  '--foreground': 'oklch(0.97 0.006 258)',
  '--card': 'oklch(0.255 0.028 258)',
  '--card-2': 'oklch(0.29 0.028 258)',
  '--card-foreground': 'oklch(0.97 0.006 258)',
  '--popover': 'oklch(0.255 0.028 258)',
  '--popover-foreground': 'oklch(0.97 0.006 258)',
  '--secondary': 'oklch(0.3 0.028 258)',
  '--secondary-foreground': 'oklch(0.97 0.006 258)',
  '--muted': 'oklch(0.3 0.028 258)',
  '--muted-foreground': 'oklch(0.73 0.02 258)',
  '--accent': 'oklch(0.33 0.03 258)',
  '--accent-foreground': 'oklch(0.97 0.006 258)',
  '--destructive': 'oklch(0.68 0.19 25)',
  '--border': 'oklch(0.36 0.03 258)',
  '--input': 'oklch(0.36 0.03 258)',
  '--radius': '0.5rem',
  '--primary': 'oklch(0.79 0.15 78)',
  '--primary-foreground': 'oklch(0.24 0.05 78)',
  '--primary-hover': 'oklch(0.85 0.14 78)',
  '--primary-soft': 'oklch(0.79 0.15 78 / 0.14)',
  '--primary-soft-2': 'oklch(0.79 0.15 78 / 0.26)',
  '--ring': 'oklch(0.79 0.15 78)',
  '--chart-1': 'oklch(0.79 0.15 78)',
  '--chart-2': 'oklch(0.7 0.12 200)',
  '--chart-3': 'oklch(0.62 0.02 258)',
  '--chart-4': 'oklch(0.48 0.02 258)',
  '--chart-5': 'oklch(0.38 0.02 258)',
  '--sidebar': 'oklch(0.165 0.03 258)',
  '--sidebar-foreground': 'oklch(0.97 0.006 258)',
  '--sidebar-accent': 'oklch(0.26 0.03 258)',
  '--sidebar-accent-foreground': 'oklch(0.97 0.006 258)',
  '--sidebar-border': 'oklch(0.3 0.03 258)',
  '--sidebar-primary': 'oklch(0.79 0.15 78)',
  '--sidebar-primary-foreground': 'oklch(0.24 0.05 78)',
  '--sidebar-ring': 'oklch(0.79 0.15 78)',
};

const CONSOLE_CSS = `body:has([data-plane="platform"]){${Object.entries(
  CONSOLE_TOKENS,
)
  .map(([name, value]) => `${name}:${value}`)
  .join(';')}}`;

interface NavItem {
  href: string;
  key: string;
  icon: LucideIcon;
  /** Only the platform owner manages the roster. */
  ownerOnly?: boolean;
}

const NAV: NavItem[] = [
  { href: '/platform', key: 'clients', icon: Building2 },
  { href: '/platform/actividad', key: 'audit', icon: ScrollText },
  { href: '/platform/equipo', key: 'operators', icon: Users2, ownerOnly: true },
] as const;

export function PlatformShell({ children }: { children: ReactNode }) {
  const identity = usePlatformIdentityValue();
  const t = useTranslations('Platform');
  const pathname = usePathname();

  const isOwner = identity.state === 'ready' && identity.role === 'owner';

  return (
    <div
      data-plane="platform"
      style={CONSOLE_TOKENS as CSSProperties}
      className="flex min-h-screen flex-col bg-background text-foreground lg:flex-row"
    >
      <style dangerouslySetInnerHTML={{ __html: CONSOLE_CSS }} />
      <aside className="shrink-0 border-b border-sidebar-border bg-sidebar lg:w-60 lg:border-r lg:border-b-0">
        <div className="flex items-center gap-3 px-4 py-3 lg:px-5 lg:py-5">
          {/* The wordmark is the tell: an operator glancing at the tab
              should never have to wonder whose screen this is. */}
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Building2 className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold tracking-tight text-sidebar-foreground">
              {t('title')}
            </p>
            <p className="hidden truncate text-xs text-muted-foreground lg:block">
              {t('subtitle')}
            </p>
          </div>
        </div>

        <nav className="flex gap-1 overflow-x-auto px-2 pb-2 lg:flex-col lg:px-3 lg:pb-4">
          {NAV.map((item) => {
            if (item.ownerOnly && !isOwner) return null;
            const active =
              item.href === '/platform'
                ? pathname === '/platform' ||
                  pathname.startsWith('/platform/clientes')
                : pathname.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  active
                    ? 'bg-primary-soft text-primary'
                    : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground',
                )}
              >
                <Icon className="size-4" />
                {t(`nav.${item.key}`)}
              </Link>
            );
          })}
        </nav>
      </aside>

      <main className="min-w-0 flex-1 p-4 sm:p-6">
        {identity.state === 'loading' ? (
          <div className="flex h-64 items-center justify-center">
            <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : identity.state === 'denied' ? (
          <div className="flex h-64 flex-col items-center justify-center gap-3 text-center">
            <ShieldOff className="size-7 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {t('errors.notOperator')}
            </p>
          </div>
        ) : (
          <PlatformIdentityProvider identity={identity}>
            {children}
          </PlatformIdentityProvider>
        )}
      </main>
    </div>
  );
}
