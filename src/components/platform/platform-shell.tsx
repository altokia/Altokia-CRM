'use client';

// ============================================================
// The Altokia console shell.
//
// This is a different product from the CRM, for a different person,
// and the surest way to cause an expensive mistake is to let an
// operator forget which of the two they are looking at. So the console
// does not reuse the CRM's shell, and it does not inherit the CRM's
// theme either: it wears Altokia's own colors — the ink ground and the
// violet accent from the logo — regardless of the accent and
// light/dark mode the signed-in person picked for their CRM. The
// wordmark in the corner and the gradient rule under it say whose
// screen this is before an operator has read a single label.
//
// The palette and the two mechanisms that pin it (inline properties
// for the subtree, a `data-plane` rule for the portals that escape it)
// live in src/components/brand/altokia-theme.ts, shared with the
// sign-in screen — the other surface that belongs to Altokia rather
// than to the client.
// ============================================================

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Building2, ScrollText, ShieldOff, Users2, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { AltokiaLogo } from '@/components/brand/altokia-logo';
import {
  ALTOKIA_SURFACE_STYLE,
  altokiaSurfaceCss,
} from '@/components/brand/altokia-theme';
import { cn } from '@/lib/utils';
import {
  PlatformIdentityProvider,
  usePlatformIdentityValue,
} from './use-platform-identity';

const CONSOLE_CSS = altokiaSurfaceCss('platform');

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
      style={ALTOKIA_SURFACE_STYLE}
      className="flex min-h-screen flex-col bg-background text-foreground lg:flex-row"
    >
      <style dangerouslySetInnerHTML={{ __html: CONSOLE_CSS }} />
      <aside className="shrink-0 border-b border-sidebar-border bg-sidebar lg:w-60 lg:border-r lg:border-b-0">
        <div className="px-4 py-3 lg:px-5 lg:py-5">
          {/* The wordmark is the tell: an operator glancing at the tab
              should never have to wonder whose screen this is. It also
              carries the console's name as its accessible label, so
              screen readers still hear "Consola Altokia" without the
              sighted version repeating the word next to the logo. */}
          <AltokiaLogo
            size={20}
            title={t('title')}
            className="text-sidebar-foreground"
          />
          <p className="mt-2 hidden truncate text-[11px] font-medium tracking-[0.14em] text-muted-foreground uppercase lg:block">
            {t('consoleSubtitle')}
          </p>
        </div>

        {/* The brand gesture, spent once on this screen: a hairline of
            cyan → violet → magenta under the wordmark. The gradient
            never grows past this — it is unreadable behind text and
            cheap-looking as a field. */}
        <div
          aria-hidden="true"
          className="h-0.5 w-full"
          style={{ backgroundImage: 'var(--altokia-gradient)' }}
        />

        <nav className="flex gap-1 overflow-x-auto px-2 pt-2 pb-2 lg:flex-col lg:px-3 lg:pt-4 lg:pb-4">
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
                  'flex shrink-0 items-center gap-2.5 px-3.5 py-2.5 text-sm font-medium transition-colors',
                  'rounded-[var(--altokia-radius-md)]',
                  // The active label takes the *lifted* violet, not
                  // --primary: raw #6D4AFF on the ink ground is 3.9:1,
                  // which is fine under a button but not for a 14px
                  // label. The lifted mix clears 8:1.
                  active
                    ? 'bg-primary-soft text-altokia-violet-lift'
                    : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground',
                )}
              >
                <Icon size={18} strokeWidth={1.75} className="shrink-0" />
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
