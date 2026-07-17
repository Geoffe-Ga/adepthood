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
| `accent.onPrimary`            | `#ffffff`  | foreground on the accent fill — 5.3:1         |
| `surfaceShadow.{card,raised}` | ink-tinted | warm downward elevation (iOS/web + Android)   |

**Contrast contract:** every `ink.*` value and the on-canvas `accent.*` values
(`primary`, `strong`) clear WCAG AA (≥ 4.5:1) on `surface.canvas`;
`accent.onPrimary` is a foreground that clears AA on the `accent.primary` fill
instead. Enforced by `__tests__/semanticTokens.test.ts`.

**Bottom fade** (`components/layout/BottomFade.tsx`, `rhythm.bottomFadeHeight`)
is the paper ground rising to absorb the last inch of scrolling content — quiet
and structural, not decorative. It gradients from transparent to `surface.canvas`
exactly, never black, so the veil reads as more of the same ground rather than a
grey shadow at the screen's end. `ScreenScaffold` renders it automatically in
`scroll` mode.

## Palette provenance

The accent is an **original** terracotta/sienna derived from the app's own
`colors.tier.clear` (`#be6e46`, a graphical-only ~3:1 swatch), darkened so it
clears AA as text. It is **not** copied from any product or brand. See
[`ATTRIBUTION`](./ATTRIBUTION).

## Type system (`type(width)`, #800)

A cohesive serif-display + clean-sans ramp, responsive on the same breakpoint
base as `typography()`:

- **Faces** — `fonts.serif` (display/title/heading) + `fonts.sans` (body/label/
  caption). Both are **platform-system stacks**; no bundled font files. The
  journal keeps its all-serif `editorialType` for long-form reading and now
  shares `fonts.serif` as its source.
- **Ramp** — `type(width)` → `{ display, title, heading, body, label, caption }`,
  each `{ fontFamily, fontSize, lineHeight, fontWeight }`; sizes descend and
  scale up from phone → tablet.
- **Interactive-text floor** — `INTERACTIVE_TEXT_MIN` (16) is the legibility
  floor for any tappable label; `editorialType.action` (serif, 16/24/600) and
  `uiType.button` both source it. `editorialType.caption` (13px) is reserved for
  **non-interactive** metadata — timestamps, eyebrows, hints, explainers — and
  must never style a control's label. The `interactiveTextFloor` guard test
  fails if a new `editorialType.caption` usage appears without being audited as
  non-interactive, so caption sizing cannot silently reach tappable text again.

## Constraints (carried from the epic)

- **No proprietary fonts** — both serif and sans are free/system stacks
  (`fonts.serif` / `fonts.sans`); any bundled OFL/Apache face must commit its
  license. See #800 and `ATTRIBUTION`.
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

## Showcase surfaces (Act II, #826)

A warm-dark "designed product" band on an otherwise light screen — the hero
moment for Today, the Practice player, the Course cover, and the Map celebration.

- `showcase.canvas` `#2a211a` / `showcase.raised` `#352a20` — deep warm **umber**
  (red channel above blue; not navy, not `#121212`), an original derivation of
  the app's own warm ink.
- `onShowcase.{primary,soft,muted}` (`#f3ece0` / `#cdbfae` / `#a8967c`) — every
  value clears WCAG AA on the umber (13.4 / 8.8 / 5.5:1); enforced by
  `showcaseTokens.test.ts`.
- `showcaseShadow` — ink-tinted portable elevation (iOS/web shadow\* + Android).
- Primitives (`components/layout/`): `ShowcaseCard` (rounded umber band) and
  `CalloutBand` (full-bleed `accent.primary` band with an inverted cream CTA —
  `surface.canvas` at 4.9:1 AA on the accent; used scarcely).
