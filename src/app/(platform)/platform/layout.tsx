import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { PlatformShell } from '@/components/platform/platform-shell';

// Server layout: it exists so this plane can own its <title> and its
// noindex headers, which a client component cannot export. Everything
// interactive lives in PlatformShell.
//
// The tab title is the console's name, not the CRM's — an operator
// with a dozen tabs open should be able to find this one without
// clicking through them.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Platform');
  return {
    title: t('title'),
    robots: {
      index: false,
      follow: false,
      nocache: true,
      googleBot: {
        index: false,
        follow: false,
        noimageindex: true,
      },
    },
  };
}

export default function PlatformLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <PlatformShell>{children}</PlatformShell>;
}
