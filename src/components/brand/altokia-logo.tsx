// ============================================================
// The Altokia wordmark.
//
// HONEST NOTE ABOUT WHAT THIS IS
// -----------------------------
// This is an *approximation* of the logo, not the logo. Hand-tracing
// a typeface into SVG paths reliably looks wrong, so the letters here
// are a real <text> element set in a geometric grotesque font stack,
// with each glyph placed on a fixed grid so the layout does not move
// when the stack falls through to a different font. Two consequences
// are worth stating plainly:
//
//   * The A keeps its crossbar. The real mark's A is an open triangle
//     with no crossbar; no font in the stack does that, and faking it
//     with an overlay would break the moment a different font
//     resolved.
//   * Cap height is assumed (0.72em) when sizing the split O, so the
//     O may sit a hair taller or shorter than the letters depending
//     on which font the machine actually has.
//
// When the owner hands over the official SVG, replace THIS FILE
// wholesale — keep the exported names (`AltokiaLogo`, `AltokiaMark`)
// and the `size` / `mono` props, and nothing else in the codebase has
// to change. See public/brand/README.md.
//
// The one part that is exact is the O: it is drawn as geometry (two
// stroked half-circles, cyan left, violet right), not as a glyph, so
// the split lands where it should regardless of the font. `AltokiaMark`
// is that same O on its own, for places too narrow for the wordmark —
// a tab, an avatar, a collapsed rail.
//
// Colors come from the brand tokens in globals.css, so changing a hex
// there changes the mark too. The white letters use currentColor,
// which is what makes `mono` free: it only has to stop overriding the
// O and the K.
// ============================================================

import { cn } from '@/lib/utils';

/** Glyphs, in order. Index 3 (the O) is drawn as geometry, not text. */
const LETTERS = ['A', 'L', 'T', 'O', 'K', 'I', 'A'] as const;
const O_INDEX = 3;
const K_INDEX = 4;

// Layout grid, in SVG user units. Each letter is centred in its own
// cell, which is what makes the wide tracking stable across fonts:
// glyph widths may differ, glyph *origins* never do.
const CELL = 26;
const FONT_SIZE = 22;
const CAP_HEIGHT = FONT_SIZE * 0.72; // assumed; see the note above
const BASELINE = 24;
const VIEW_W = CELL * LETTERS.length; // 182
const VIEW_H = 32;
const WORDMARK_RATIO = VIEW_W / VIEW_H;

const letterX = (index: number) => CELL * index + CELL / 2;

// The O: cap-height circle, optically overshot a little the way a
// geometric O is drawn, with a stroke weight that reads as the same
// color mass as the letter stems.
const O_CENTER_Y = BASELINE - CAP_HEIGHT / 2;
const O_RADIUS = CAP_HEIGHT / 2 + 0.6;
const O_STROKE = FONT_SIZE * 0.115;

// No var() in here: this string is handed to inline `style`, and the
// whole declaration would be dropped if a custom property in it failed
// to resolve — taking the geometric stack down with it.
const FONT_STACK =
  '"Futura", "Century Gothic", "Avenir Next", "Avenir", "Poppins", "Montserrat", "Trebuchet MS", system-ui, sans-serif';

interface SplitOProps {
  cx: number;
  cy: number;
  r: number;
  strokeWidth: number;
  mono: boolean;
}

/**
 * The O, split down the middle: cyan on the left, violet on the right.
 * Two half-circle arcs rather than one circle with a gradient — a
 * gradient on text or on a shared bounding box lands wherever the box
 * happens to be, whereas two arcs split exactly at `cx` forever.
 * Butt caps so the halves meet flush at top and bottom.
 */
function SplitO({ cx, cy, r, strokeWidth, mono }: SplitOProps) {
  const top = `M ${cx} ${cy - r}`;
  // The brand colors arrive through `style`, not through the `stroke`
  // attribute: var() inside an SVG presentation attribute is patchily
  // supported, and a half-circle that silently fails to paint is a bad
  // way to find that out.
  return (
    <>
      <path
        d={`${top} A ${r} ${r} 0 0 0 ${cx} ${cy + r}`}
        fill="none"
        style={{ stroke: mono ? 'currentColor' : 'var(--altokia-cyan, #22d3ee)' }}
        strokeWidth={strokeWidth}
        strokeLinecap="butt"
      />
      <path
        d={`${top} A ${r} ${r} 0 0 1 ${cx} ${cy + r}`}
        fill="none"
        style={{
          stroke: mono ? 'currentColor' : 'var(--altokia-violet, #6d4aff)',
        }}
        strokeWidth={strokeWidth}
        strokeLinecap="butt"
      />
    </>
  );
}

export interface AltokiaLogoProps {
  /** Rendered height in px; the width follows the wordmark's ratio. */
  size?: number;
  /** Single-color variant, for placements where the palette can't go. */
  mono?: boolean;
  className?: string;
  /**
   * Accessible name. Pass `null` when the mark sits next to the same
   * words in text and would only be read out twice.
   */
  title?: string | null;
}

export function AltokiaLogo({
  size = 26,
  mono = false,
  className,
  title = 'Altokia',
}: AltokiaLogoProps) {
  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      height={size}
      width={size * WORDMARK_RATIO}
      className={cn('block shrink-0', className)}
      role={title ? 'img' : undefined}
      aria-label={title ?? undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <text
        y={BASELINE}
        textAnchor="middle"
        fontSize={FONT_SIZE}
        fontWeight={500}
        fill="currentColor"
        style={{ fontFamily: FONT_STACK }}
      >
        {/* The key carries the index because ALTOKIA has two A's:
            position, not the glyph, is what identifies a cell. */}
        {LETTERS.map((letter, index) =>
          index === O_INDEX ? null : (
            <tspan
              key={`${letter}-${index}`}
              x={letterX(index)}
              style={
                index === K_INDEX && !mono
                  ? { fill: 'var(--altokia-magenta, #ff2d8f)' }
                  : undefined
              }
            >
              {letter}
            </tspan>
          ),
        )}
      </text>
      <SplitO
        cx={letterX(O_INDEX)}
        cy={O_CENTER_Y}
        r={O_RADIUS}
        strokeWidth={O_STROKE}
        mono={mono}
      />
    </svg>
  );
}

export interface AltokiaMarkProps {
  /** Rendered size in px; the mark is square. */
  size?: number;
  mono?: boolean;
  className?: string;
  title?: string | null;
}

/**
 * The split O on its own — the wordmark reduced to the one part of it
 * that survives being 16px tall.
 */
export function AltokiaMark({
  size = 24,
  mono = false,
  className,
  title = 'Altokia',
}: AltokiaMarkProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      height={size}
      width={size}
      className={cn('block shrink-0', className)}
      role={title ? 'img' : undefined}
      aria-label={title ?? undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <SplitO cx={16} cy={16} r={12.4} strokeWidth={3.6} mono={mono} />
    </svg>
  );
}
