// ============================================================
// The Altokia surface — how the brand palette drives the product's
// own semantic tokens inside the operator console.
//
// The console and the customer's CRM are two products that happen to
// share a component library. The components read `--background`,
// `--card`, `--primary` and friends; this file re-points that whole
// set at the Altokia palette for the console's subtree, so not a
// single component had to learn about the brand.
//
// Two mechanisms, because one is not enough:
//   1. `ALTOKIA_SURFACE_STYLE` — inline vars on the surface root,
//      covering everything rendered inside it.
//   2. `altokiaSurfaceCss()` — a rule keyed off the same `data-plane`
//      attribute, covering what escapes that subtree. Base UI portals
//      dialogs and select popups onto document.body, and a
//      client-accented dialog floating over the Altokia console would
//      undo the whole point.
//
// The rule sits at the same specificity as globals.css's
// `html[data-mode="…"]` block but appears later in the document (an
// inline <style> in the body, vs. a <link> in the head), so it wins.
// If a browser lacks :has(), mechanism 1 still holds the page itself.
//
// LIGHT AND DARK BOTH WORK, and for free. Every value below points at
// a `--altokia-*` token, and those already swap with `data-mode` in
// globals.css. So this mapping is written once, mode-agnostically:
// what changes underneath is the palette, not the wiring. An earlier
// version hard-coded a dark ground and broke the moment the light
// palette landed.
//
// CONTRAST. The raw brand values are not interchangeable with their
// text variants. Violet as a fill under white text is fine; violet as
// 14px text is not, so text-weight violet goes through
// `--altokia-violet-text`, which globals.css mixes per mode. Magenta
// is an accent only: marks, borders, the gradient rule.
// ============================================================

import type { CSSProperties } from 'react';

/** A step between two ground tokens — the neutral ladder. */
const mix = (a: string, b: string, percent: number) =>
  `color-mix(in oklab, ${a} ${percent}%, ${b})`;

const violetAlpha = (percent: number) =>
  `color-mix(in oklab, var(--altokia-violet) ${percent}%, transparent)`;

const ALTOKIA_SURFACE_TOKENS: Record<string, string> = {
  // ---- grounds ------------------------------------------------
  '--background': 'var(--altokia-bg)',
  '--foreground': 'var(--altokia-text)',
  '--card': 'var(--altokia-surface)',
  '--card-2': 'var(--altokia-surface-2)',
  '--card-foreground': 'var(--altokia-text)',
  '--popover': 'var(--altokia-surface)',
  '--popover-foreground': 'var(--altokia-text)',
  '--secondary': 'var(--altokia-surface-2)',
  '--secondary-foreground': 'var(--altokia-text)',
  '--muted': 'var(--altokia-surface-2)',
  '--muted-foreground': 'var(--altokia-text-soft)',
  '--accent': 'var(--altokia-surface-2)',
  '--accent-foreground': 'var(--altokia-text)',
  '--border': 'var(--altokia-border)',
  '--input': 'var(--altokia-border)',

  // ---- brand --------------------------------------------------
  '--primary': 'var(--altokia-violet)',
  '--primary-foreground': 'var(--altokia-white)',
  '--primary-hover': 'var(--altokia-violet-hover)',
  '--primary-soft': 'var(--altokia-tint)',
  '--primary-soft-2': violetAlpha(28),
  // The focus ring has to be *seen* on both grounds, so it takes the
  // text-weight violet rather than the fill.
  '--ring': 'var(--altokia-violet-text)',

  // ---- signals ------------------------------------------------
  // Danger keeps the brand's own red. It is a signal, not decoration,
  // and the one place an operator must not have to decode a palette.
  '--destructive': 'var(--altokia-danger)',
  '--destructive-foreground': 'var(--altokia-white)',

  // ---- charts -------------------------------------------------
  // Brand first, then the neutral ladder, so a chart never reaches for
  // a colour that means something else somewhere on the same screen.
  '--chart-1': 'var(--altokia-violet)',
  '--chart-2': 'var(--altokia-cyan)',
  '--chart-3': 'var(--altokia-magenta)',
  '--chart-4': mix('var(--altokia-text-soft)', 'var(--altokia-bg)', 70),
  '--chart-5': mix('var(--altokia-text-soft)', 'var(--altokia-bg)', 40),

  // ---- the rail -----------------------------------------------
  // `--altokia-rail` is defined per mode in globals.css and this is why
  // it exists as its own token: in light it lifts to white against the
  // grey canvas, in dark it sits level with the canvas and is separated
  // by the hairline alone. Both come straight off the mockups, and the
  // two behaviours cannot be expressed by pointing at one ground.
  '--sidebar': 'var(--altokia-rail)',
  '--sidebar-foreground': 'var(--altokia-text)',
  '--sidebar-accent': 'var(--altokia-surface-2)',
  '--sidebar-accent-foreground': 'var(--altokia-text)',
  '--sidebar-border': 'var(--altokia-border)',
  '--sidebar-primary': 'var(--altokia-violet)',
  '--sidebar-primary-foreground': 'var(--altokia-white)',
  '--sidebar-ring': 'var(--altokia-violet-text)',

  // ---- shape and type -----------------------------------------
  // 11px is the design system's middle radius: buttons, inputs, nav
  // items. The other four are available as --altokia-radius-* for the
  // places that want them.
  '--radius': 'var(--altokia-radius-md)',
  // Plus Jakarta Sans for the interface, JetBrains Mono for data.
  // Re-pointing the product's own font vars means every existing
  // component picks them up without a class change — and it stops at
  // this subtree, so the customer's CRM keeps Inter.
  '--font-sans': 'var(--font-altokia-ui)',
  '--font-heading': 'var(--font-altokia-display)',
  '--font-mono': 'var(--font-altokia-mono)',
  // Re-pointing the variables is NOT enough on its own, and this is
  // the trap: globals.css declares `html { font-family: var(--font-sans) }`
  // exactly once, so every descendant inherits the *computed* family.
  // Changing the variable further down the tree resolves against
  // nothing — the console kept rendering in Inter while every token
  // said otherwise. Declaring the family here is what actually makes
  // the subtree switch, and it stops at the subtree, so the customer's
  // CRM is untouched.
  fontFamily: 'var(--font-altokia-ui)',
};

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
  return `body:has([data-plane="${plane}"]){${declarations};font-family:var(--font-altokia-ui)}`;
}
