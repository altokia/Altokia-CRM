# Altokia brand assets

This folder is where the **official** Altokia artwork goes when the
owner hands it over. It is empty on purpose: nothing here is a
placeholder to be edited around.

## Where the mark lives today

There is no official SVG yet, so the wordmark is **drawn in code**:

    src/components/brand/altokia-logo.tsx

It sets ALTOKIA in a geometric sans font stack on a fixed per-letter
grid, draws the split cyan/violet O as real geometry, and paints the K
magenta. It is an approximation and says so in its own header comment —
most visibly, its A keeps the crossbar that the real mark drops.

The colors it uses are not written in that file either. They come from
the six brand tokens in:

    src/app/globals.css        →  the `BRAND` block, `--altokia-*`

Everything else (the console chrome, the sign-in screen) derives from
those six with `color-mix()`, through:

    src/components/brand/altokia-theme.ts

## When the official SVG arrives

1. Drop the file in here, e.g. `public/brand/altokia-wordmark.svg`
   (plus `altokia-mark.svg` for the standalone split O, if there is
   one, and any raster favicon/social image).
2. Replace **`src/components/brand/altokia-logo.tsx`** wholesale —
   inline the official paths, or render the asset from this folder.
   Keep the two exports and their props:

   - `AltokiaLogo({ size, mono, className, title })` — `size` is the
     rendered height in px, `mono` is the single-color variant that
     follows `currentColor`.
   - `AltokiaMark({ size, mono, className, title })` — the split O
     alone, square, for places too narrow for the wordmark (a tab, an
     avatar, a collapsed rail).

   Keep `currentColor` for the letters that are white in the full-color
   version: that is what makes `mono` work without a second asset.
3. If the official artwork comes with exact brand values, update the
   six hexes in the `BRAND` block of `src/app/globals.css`. Nothing
   else needs touching — every derived color is a `color-mix()` off
   those.

Nothing else in the codebase references the wordmark's internals, so
steps 2 and 3 are the whole job.

## Where the mark is used

Only the two surfaces that belong to Altokia rather than to the
customer:

- the operator console at `/platform`
  (`src/components/platform/platform-shell.tsx`)
- the sign-in screen (`src/app/(auth)/login/page.tsx`)

**Not** the CRM itself. A customer's workspace carries the customer's
own terminology and accent color; stamping Altokia across it is the
opposite of what the product is for.
