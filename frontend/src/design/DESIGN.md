# Candle & Ink — Adepthood's warm-editorial design language

The canonical reference for Adepthood's visual language (epic #798). Where the
code and this doc disagree, `tokens.ts` wins — update this doc to match.

## Intent

A warm, literary, paper-on-desk feel — the opposite of flat grey SaaS chrome.
The language began on the journal-resonance surface (`colors.paper`,
`editorialType`, `paperShadow`) and is now promoted app-wide through a semantic
`surface` / `ink` / `accent` layer.

## Semantic layer (`tokens.ts`)

| Token                         | Value      | Role                                          |
| ----------------------------- | ---------- | --------------------------------------------- |
| `surface.canvas`              | `#faf6ef`  | the app ground (warm off-white paper)         |
| `surface.raised`              | `#ffffff`  | lifted cards / sheets                         |
| `surface.sunken`              | `#f3ecdf`  | recessed wells                                |
| `surface.desk`                | `#e7dcc8`  | the deeper ground a sheet floats above        |
| `surface.hairline`            | `#e3dccd`  | faint warm rule                               |
| `ink.primary`                 | `#2b2620`  | body text — 13.9:1 on canvas (AAA)            |
| `ink.soft`                    | `#5a5046`  | secondary text — 7.3:1 (AAA)                  |
| `ink.muted`                   | `#6b6055`  | captions / placeholders — 5.7:1               |
| `accent.primary`              | `#a5572f`  | terracotta accent — 4.9:1 (clears AA as text) |
| `accent.strong`               | `#8f4a28`  | pressed / emphasis — 6.1:1                    |
| `surfaceShadow.{card,raised}` | ink-tinted | warm downward elevation (iOS/web + Android)   |

**Contrast contract:** every `ink.*` and `accent.*` value clears WCAG AA
(≥ 4.5:1) on `surface.canvas`. Enforced by `__tests__/semanticTokens.test.ts`.

## Palette provenance

The accent is an **original** terracotta/sienna derived from the app's own
`colors.tier.clear` (`#be6e46`, a graphical-only ~3:1 swatch), darkened so it
clears AA as text. It is **not** copied from any product or brand. See
[`ATTRIBUTION`](./ATTRIBUTION).

## Constraints (carried from the epic)

- **No proprietary fonts** — editorial type uses a free/system serif stack
  (see `editorialType.serif`); see #800.
- **No third-party brand marks or swatches** presented as our own.
- **Additive, not destructive** — the legacy grey `colors.background` /
  `colors.surface` remain for un-migrated screens; this layer is the new
  default, adopted screen-by-screen across the #798 sub-issues.
- **Reuse the existing warm values** — `surface`/`ink` are derived from
  `colors.paper`, not a parallel palette.

## Adoption map (epic #798)

- #799 — this token layer + provenance (critical path)
- #800 — editorial type system on free/system fonts
- #801 — shared buttons, controls & inputs
- #802 — warm grounds & soft elevation for cards/surfaces
- #803 — editorial navigation (headers + bottom tab bar)
- #804 — warm dark mode matching the light language
