// ============================================================
// Altokia's palette, mapped onto the product's tokens.
//
// Two screens belong to Altokia rather than to the client: the
// console at /platform and the sign-in screen. Both need the same
// treatment — pin the brand ground and the violet accent, ignoring
// whatever mode and accent the visitor picked for their CRM — so the
// mapping lives here once instead of drifting apart in two files.
//
// Everything derives from the six raw hexes in globals.css via
// color-mix(), so changing a hex there restyles both surfaces and
// nothing else. Nothing in this file hardcodes a color.
//
// Two mechanisms apply it, on purpose:
//
//   1. `ALTOKIA_SURFACE_STYLE` — inline custom properties on the
//      surface's root element, covering everything inside it.
//   2. `altokiaSurfaceCss()` — a rule keyed off the same
//      `data-plane` attribute, covering what escapes that subtree.
//      Base UI portals dialogs and select popups onto document.body,
//      and a client-accented dialog floating over the Altokia console
//      would undo the whole point.
//
// The rule sits at the same specificity as globals.css's
// `html[data-mode="…"]` block but appears later in the document (an
// inline <style> in the body, vs. a <link> in the head), so it wins.
// If a browser lacks :has(), mechanism 1 still holds the page itself.
//
// CONTRAST. This palette is built for a dark ground and the raw
// values are not interchangeable. Violet on ink is 3.9:1 — fine as a
// button fill under white text (5.2:1), too low for small text, so
// text-weight violet goes through --altokia-violet-lift (8:1).
// Magenta is an accent only: marks, borders, the gradient rule.
// ============================================================

import type { CSSProperties } from 'react';

/** Neutral steps, mixed off the two brand grounds. */
const lift = (percent: number) =>
  `color-mix(in oklab, var(--altokia-surface) ${percent}%, var(--altokia-white))`;
const dim = (percent: number) =>
  `color-mix(in oklab, var(--altokia-white) ${percent}%, var(--altokia-ink))`;
const violetAlpha = (percent: number) =>
  `color-mix(in oklab, var(--altokia-violet) ${percent}%, transparent)`;
/** Hairlines read off the ink, not the surface, so they hold on both. */
const hairline = `color-mix(in oklab, var(--altokia-ink) 78%, var(--altokia-white))`;

const ALTOKIA_SURFACE_TOKENS: Record<string, string> = {
  // Inverted against the CRM on purpose. The customer's dark theme has
  // a LIGHTER sidebar on a darker canvas; the console has the true ink
  // in the rail and a lifted canvas beside it. That one relationship,
  // read before any text is, is what tells an operator which of the two
  // products they are looking at — the reason for branding the console
  // at all. Sharing one value between background and sidebar, as this
  // did first, left the two panes separated by a hairline and nothing
  // else.
  '--background': 'var(--altokia-surface)',
  '--foreground': 'var(--altokia-white)',
  '--card': lift(92),
  '--card-2': lift(86),
  '--card-foreground': 'var(--altokia-white)',
  '--popover': 'var(--altokia-surface)',
  '--popover-foreground': 'var(--altokia-white)',
  '--secondary': lift(90),
  '--secondary-foreground': 'var(--altokia-white)',
  '--muted': lift(90),
  '--muted-foreground': dim(62),
  '--accent': lift(86),
  '--accent-foreground': 'var(--altokia-white)',
  // Danger stays red. It is a signal, not a brand color, and the one
  // place an operator must not have to decode a palette.
  '--destructive': 'oklch(0.68 0.19 25)',
  '--border': hairline,
  '--input': hairline,
  '--radius': '0.5rem',
  '--primary': 'var(--altokia-violet)',
  '--primary-foreground': 'var(--altokia-white)',
  // Darker on hover, not lighter: white on the lightened violet measured
  // 3.36:1, so a primary button's own label failed the moment the
  // pointer touched it.
  '--primary-hover': 'color-mix(in oklab, var(--altokia-violet) 86%, black)',
  '--primary-soft': violetAlpha(16),
  '--primary-soft-2': violetAlpha(28),
  // The focus ring has to be *seen*, so it takes the lifted violet
  // rather than the fill violet.
  '--ring': 'var(--altokia-violet-lift)',
  '--chart-1': 'var(--altokia-violet)',
  '--chart-2': 'var(--altokia-cyan)',
  '--chart-3': 'var(--altokia-magenta)',
  '--chart-4': dim(46),
  '--chart-5': dim(30),
  '--sidebar': 'var(--altokia-ink)',
  '--sidebar-accent-2': 'var(--altokia-surface)',
  '--sidebar-foreground': 'var(--altokia-white)',
  '--sidebar-accent': lift(88),
  '--sidebar-accent-foreground': 'var(--altokia-white)',
  '--sidebar-border': hairline,
  '--sidebar-primary': 'var(--altokia-violet)',
  '--sidebar-primary-foreground': 'var(--altokia-white)',
  '--sidebar-ring': 'var(--altokia-violet-lift)',
};

/** Ready to spread onto a surface root's `style`. */
export const ALTOKIA_SURFACE_STYLE = ALTOKIA_SURFACE_TOKENS as CSSProperties;

/**
 * The same tokens as a stylesheet rule, for the portals that render
 * outside the surface's subtree. `plane` is the `data-plane` value the
 * surface root carries.
 */
export function altokiaSurfaceCss(plane: string): string {
  const declarations = Object.entries(ALTOKIA_SURFACE_TOKENS)
    .map(([name, value]) => `${name}:${value}`)
    .join(';');
  return `body:has([data-plane="${plane}"]){${declarations}}`;
}
