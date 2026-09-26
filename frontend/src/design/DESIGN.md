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
grey shadow at the screen's end. Two rules keep it a dissolve rather than a band:

- **Ease the alpha, never ramp it linearly.** `BOTTOM_FADE_STOPS` samples a
  cubic ease-in (`alpha = t³`). A constant-rate ramp puts a slope discontinuity
  where the veil meets live prose, and the eye exaggerates that into a Mach
  band — a visible line, with a grey slab under it. The eased ramp starts at a
  near-zero slope (two percent through the first quarter) and only turns
  assertive in its last quarter, where the ground behind it already matches.
- **Fade into the ground actually beneath the veil.** The optional `color` prop
  exists for scrollers floated on a different surface, and it must name what the
  veil physically covers, not what the screen sits on. The Course chapter reader
  passes `surface.canvas` — the reading sheet's own ground — because the sheet
  is what the veil overlays for all but the very end of the scroll. A terminal
  color that matches nothing underneath is what makes trailing text look like it
  is fading into nothing.

`ScreenScaffold` renders it automatically in `scroll` mode.

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

## Text in order (epic #2946)

The app exists to get a life in order. An interface that is not itself in
order cannot promote that — the medium is the message — so every string on a
screen has one place it belongs, one edge it shares with its siblings, and one
face for its role. Buttons and their rows are governed by the forthcoming
`## Action rows` section (#2860); this section governs text and does not
restate it.

Seven rules, each one a reviewer can answer yes or no:

- **Scope.** A string lives inside the component whose subject it describes —
  a hint about an option sits inside that option's box, a page's word count
  sits in the page's footer rail, a note about the whole corpus is its own card
  — and a string that does not describe the component it is in is moved or
  given a component.
- **One edge.** Sibling strings in a group share one left edge (or one right
  edge) and, on one row, one baseline; indenting a lone line by a padding value
  is not alignment.
- **One face per role.** Within one screen region a role (eyebrow / link /
  meta) is set in one face, one size and one colour, a region shows at most
  **three** sizes of the `type(width)` ramp, and `editorialType.caption` styles
  non-interactive metadata only (the `INTERACTIVE_TEXT_MIN` floor above), in
  `ink.muted` or `ink.soft`.
- **Glyph over word.** An action whose meaning is universal (close, dismiss,
  back, camera, search, add, play, minimise) is a `lucide-react-native` icon
  with the word kept as its `accessibilityLabel` and a hit area of at least
  `touchTarget.minimum`, never a text link; words are for actions that need
  them (Finish, Get Resonance, Begin a page).
- **Eyebrows are eyebrows.** A screen spends its one small-caps (upper-cased
  caption) role on its screen or section heading — `ScreenHeader`'s `eyebrow`
  (`type(width).caption` in `accent.primary`) or one list spine such as the
  journal shelf's `sectionHeading` — while sub-section labels inside a band are
  sentence-case `editorialType.caption` in `ink.muted` on the band's left edge
  (or `EditorialSection`'s serif `title`), never a bold serif line that
  competes with the content it labels; the
  `features/Journal/__tests__/JournalShelfHierarchy.test.ts` guard, which pins
  `textTransform: 'uppercase'` to exactly one shelf style, is the precedent.
- **No raw markup.** Body text that can carry Markdown is rendered through
  `react-native-markdown-display` (as the Course `ChapterReader` does) or the
  journal's `LiveMarkdownBody` / `parseJournalMarkdown` pipeline, or has its
  markers stripped before display; a visible `**` is a bug.
- **Counts fold into their label.** A string that is a count plus an action
  ("4 prompts set aside — show them") puts the count in the eyebrow row's
  trailing slot and makes the action the row's affordance, rather than
  spelling both out in one link.

**Primitives** — reach for these before adding a bare `<Text>`:
`components/layout/ScreenHeader.tsx` (eyebrow → title → lead, right `action`
slot), `components/layout/EditorialSection.tsx` (titled band),
`components/RadioOption.tsx`, `components/StatRow.tsx`,
`components/TextField.tsx`, `components/Button.tsx` variants, and
`features/Journal/ReflectionDismiss.tsx` with `variant="close"` (the icon-only
X that landed via #2862) as the reference for glyph-over-word.

**How to check** — the text-census harness
`frontend/e2e/text-order.browser.e2e.test.ts` (#2948) will screenshot every
route at both viewports and write
`frontend/e2e/artifacts/text-order/<viewport>/<route>.{png,json}` — one image
plus one census of every text node's string, size, box and nearest `testID` —
and the review protocol that reads those artifacts screen by screen is
`prompts/scans/text-order.md`.

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
