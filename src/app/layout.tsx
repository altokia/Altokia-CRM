import type { Metadata, Viewport } from "next";
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import {
  Inter,
  JetBrains_Mono,
  Plus_Jakarta_Sans,
  Sora,
} from "next/font/google";
import Script from "next/script";
import "./globals.css";
import { ThemeProvider } from "@/hooks/use-theme";
import { ThemedToaster } from "@/components/themed-toaster";
import {
  DEFAULT_MODE,
  DEFAULT_THEME,
  MODE_STORAGE_KEY,
  MODES,
  STORAGE_KEY,
  THEME_IDS,
} from "@/lib/themes";

// ------------------------------------------------------------------
// TYPE — two families of families, deliberately kept apart.
//
// Inter under --font-sans is the CLIENT's CRM. It is what
// `html { font-family: var(--font-sans) }` in globals.css resolves to,
// so it dresses every dashboard screen and must keep doing exactly
// that: the CRM is the customer's tool and wearing Altokia's face is
// the wrong product.
//
// The three below are ALTOKIA's. They are declared here — the only
// place next/font may be called for a variable that has to exist on
// <html> — but they only *paint* inside the two surfaces that belong
// to Altokia rather than to the client: the console at /platform and
// the sign-in screen. Those surfaces re-point --font-sans at
// --font-altokia-ui for their own subtree, the same way they already
// re-point the color tokens (see components/brand/altokia-theme.ts).
// Nothing outside them reads these variables, so the CRM renders
// byte-for-byte as it did before.
//
// preload:false is on purpose. next/font preloads whatever the root
// layout declares, on every route — which would put six brand font
// files in front of every CRM page that never renders one of them.
// The @font-face rules still ship in the same stylesheet, so the
// console picks the faces up on first paint; with display:'swap' and
// Next's metric-matched fallback the worst case is a brief fallback
// frame on an internal ops screen, which is the right side of that
// trade. Flip these to true if the console ever becomes the hot path.
// ------------------------------------------------------------------

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
});

/** Big titles and the wordmark. Light 300, semibold 600. */
const sora = Sora({
  variable: "--font-altokia-display",
  subsets: ["latin"],
  weight: ["300", "600"],
  display: "swap",
  preload: false,
  fallback: ["Segoe UI", "system-ui", "sans-serif"],
});

/** Every piece of console UI: buttons, menus, labels, tables. */
const plusJakartaSans = Plus_Jakarta_Sans({
  variable: "--font-altokia-ui",
  subsets: ["latin"],
  weight: ["400", "600", "700"],
  display: "swap",
  preload: false,
  fallback: ["Segoe UI", "system-ui", "sans-serif"],
});

/** Data only: phone numbers, amounts, dates, identifiers. */
const jetBrainsMono = JetBrains_Mono({
  variable: "--font-altokia-mono",
  subsets: ["latin"],
  weight: ["400"],
  display: "swap",
  preload: false,
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
});

/** The four font variables, declared on <html> so both planes see them. */
const FONT_VARIABLES = [
  inter.variable,
  sora.variable,
  plusJakartaSans.variable,
  jetBrainsMono.variable,
].join(" ");

export const metadata: Metadata = {
  title: {
    default: "wacrm",
    template: "%s — wacrm",
  },
  description: "Self-hostable CRM template for WhatsApp.",
  robots: {
    index: false,
    follow: false,
  },
  icons: {
    icon: [{ url: "/icon" }],
  },
  formatDetection: {
    email: false,
    address: false,
    telephone: false,
  },
};

export const viewport: Viewport = {
  themeColor: "#020617",
  colorScheme: "dark light",
};

// Inline boot script — runs before React hydrates so the user's
// chosen accent (data-theme) AND mode (data-mode) are on the <html>
// element before first paint. Without this every page load flashes
// the server-rendered defaults for a frame before the React tree
// mounts and applies the picked values.
//
// Kept dependency-free (no imports, no JSX) — must be a string the
// browser can run as a single <script>. Knowledge of valid ids is
// sourced from the THEME_IDS / MODES constants so adding one doesn't
// silently break the boot path.
const THEME_BOOT_SCRIPT = `
(function(){
  var d = document.documentElement;
  try {
    var THEME_KEY = ${JSON.stringify(STORAGE_KEY)};
    var THEME_DEFAULT = ${JSON.stringify(DEFAULT_THEME)};
    var THEMES = ${JSON.stringify(THEME_IDS)};
    var savedTheme = localStorage.getItem(THEME_KEY);
    d.dataset.theme = THEMES.indexOf(savedTheme) !== -1 ? savedTheme : THEME_DEFAULT;

    var MODE_KEY = ${JSON.stringify(MODE_STORAGE_KEY)};
    var MODE_DEFAULT = ${JSON.stringify(DEFAULT_MODE)};
    var MODES = ${JSON.stringify(MODES)};
    var savedMode = localStorage.getItem(MODE_KEY);
    d.dataset.mode = MODES.indexOf(savedMode) !== -1 ? savedMode : MODE_DEFAULT;
  } catch (_e) {
    d.dataset.theme = ${JSON.stringify(DEFAULT_THEME)};
    d.dataset.mode = ${JSON.stringify(DEFAULT_MODE)};
  }
})();
`;

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html
      lang={locale}
      data-theme={DEFAULT_THEME}
      data-mode={DEFAULT_MODE}
      className={`${FONT_VARIABLES} h-full antialiased`}
      // The `theme-boot` script below rewrites `data-theme` and
      // `data-mode` on <html> from localStorage before React hydrates,
      // so for any non-default choice the client DOM intentionally
      // differs from the server-rendered defaults. suppressHydration-
      // Warning silences the expected mismatch — it only applies to
      // this element's own attributes, so genuine mismatches in
      // children still surface.
      suppressHydrationWarning
    >
      <head>
        <Script
          id="theme-boot"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }}
        />
      </head>
      <body className="min-h-full bg-background text-foreground font-sans">
        <NextIntlClientProvider messages={messages} locale={locale}>
          <ThemeProvider>
            {children}
            <ThemedToaster />
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
