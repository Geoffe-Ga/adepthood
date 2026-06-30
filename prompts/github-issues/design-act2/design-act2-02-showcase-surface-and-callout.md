# design-act2-02: Warm-dark showcase surface + accent callout band

**Labels:** `frontend`, `ux`, `design`
**Epic:** [Candle & Ink, Act II](design-act2-epic.md)
**Depends on:** — (foundation). **Coordinate with #804** (warm dark mode).
**Estimated LoC:** ~220

## Problem

The north star's single biggest "designed product" signal is its **light↔dark
surface rhythm** — a screen paces between warm cream bands and deep product
surfaces. Adepthood cannot build that: `tokens.ts` has only light grounds
(`surface.{canvas,raised,sunken,desk,hairline}`, `tokens.ts:582-588`) plus a
neutral Material `darkColors` (`#121212`, `tokens.ts:356-374`) that is for dark
*mode*, not a showcase band on a light screen. There is likewise **no full-bleed
accent moment** — the terracotta `accent.primary` is used only on small controls,
never as a generous callout band.

Result: every screen is a single flat cream tone with no hero, no contrast, no
arrival. The Today hub (04), the Practice player (07), the Course stage cover
(08), and the Map celebration (09) all need a warm-dark hero surface that does
**not** exist yet.

## Scope

Add the **showcase** surface family (a deep warm *umber*, never navy — it stays
in the candlelit world) with an AA-clearing on-showcase ink scale and a matching
elevation, plus two presentational primitives: `ShowcaseCard` and `CalloutBand`.
Tokens + primitives only; no screen consumes them here (their consumers are
04/07/08/09/10). Extend `ATTRIBUTION` to record the new tokens' clean-room
provenance.

## Tasks

### 1. Showcase tokens

In `tokens.ts`, add (proposed values — the contrast test locks them):

```ts
/**
 * The warm-dark "showcase" surface — a deep espresso umber used as a hero /
 * product band that paces against the cream canvas. NOT navy: it is the
 * candlelit-room dark, derived from the app's own warm ink, so it belongs to
 * "Candle & Ink." #804 themes these alongside the rest of dark mode.
 */
export const showcase = {
  surface: '#211c16',        // deep warm umber ground
  surfaceElevated: '#2c261d', // lifted card within a showcase band
  hairline: '#3a3328',        // faint warm rule on the dark ground
} as const;

/** Ink for text on `showcase.surface`. Every value clears AA (≥4.5:1) there. */
export const onShowcase = {
  primary: '#faf6ef',  // echoes the canvas tone — high-contrast on umber
  soft: '#cdbfa9',     // secondary text — must clear AA on showcase.surface
  accent: '#d68a5c',   // a brightened terracotta that clears AA as text on dark
} as const;

export const showcaseShadow = {
  card: { /* warm, downward, ink-tinted — iOS/web shadow* props + Android elevation */ },
} as const;
```

The accent **fill** for buttons on showcase stays `accent.primary` (large /
graphical, ≥3:1); `onShowcase.accent` is the lightened tone for accent **text**
on the dark ground. Document both.

### 2. `ShowcaseCard` primitive

New `frontend/src/components/showcase/ShowcaseCard.tsx`:
- A rounded (`radius.lg`) band on `showcase.surface` with `showcaseShadow.card`,
  generous internal padding (`rhythm.heroPaddingV` / `spacing(3)`), and a default
  text colour context of `onShowcase.primary`.
- Props: `{ children; style?; testID? }`. No behaviour.

### 3. `CalloutBand` primitive

New `frontend/src/components/showcase/CalloutBand.tsx`:
- A full-bleed **accent** band (`accent.primary` ground), `radius.lg`, white
  (`colors.text.light`) text, with a title (`type().heading`) + optional body +
  an inverted CTA (cream/`surface.canvas` button on the accent ground, matching
  the north star's "cream button on coral" inversion).
- Props: `{ title; body?; ctaLabel?; onPressCta?; testID? }`. Used scarcely —
  one high-voltage CTA per screen at most.

### 4. Provenance

Append a short note to `frontend/src/design/ATTRIBUTION` and the `DESIGN.md`
token table: the showcase umber is derived from the app's own warm ink
(`colors.paper.ink`), not any third-party swatch; the accent is the existing
`accent.primary`.

## Tasks — tests

- New `semanticTokens` assertions: `onShowcase.primary/soft/accent` each clear
  WCAG AA (≥ 4.5:1) on `showcase.surface` (compute ratio in-test, mirroring the
  existing `semanticTokens.test.ts` contrast checks).
- `ShowcaseCard.test.tsx`: root flattens to `showcase.surface` + a non-zero
  `shadowRadius`/`elevation`.
- `CalloutBand.test.tsx`: ground is `accent.primary`; CTA fires `onPressCta`;
  CTA label text clears AA on the accent ground.

## Acceptance Criteria

- Showcase + on-showcase + showcase-shadow tokens exist; every on-showcase ink
  value clears AA on the umber ground (asserted), and the umber is **not** navy
  / not `#121212`.
- `ShowcaseCard` and `CalloutBand` render token-only, AA-clearing, with portable
  shadows; 44 dp CTA touch target.
- `ATTRIBUTION` + `DESIGN.md` record the new tokens' clean-room provenance.
- Authored so #804 can theme the showcase by mode without layout/testID changes.
- `cd frontend && npm test && npm run lint && npx tsc --noEmit` green.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/design/tokens.ts` | Modify — add `showcase`/`onShowcase`/`showcaseShadow` |
| `frontend/src/design/ATTRIBUTION` | Modify — provenance note |
| `frontend/src/design/DESIGN.md` | Modify — token table + intent |
| `frontend/src/components/showcase/ShowcaseCard.tsx` | **Create** |
| `frontend/src/components/showcase/CalloutBand.tsx` | **Create** |
| `frontend/src/design/__tests__/semanticTokens.test.ts` | Modify — AA on showcase |
| `frontend/src/components/showcase/__tests__/*.test.tsx` | **Create** |
