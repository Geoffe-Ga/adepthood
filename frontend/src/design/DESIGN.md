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
face for its role. Buttons and their rows are governed by `## Action rows`
below (#2860); this section governs text and does not restate it.

Eight rules, each one a reviewer can answer yes or no:

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
- **Decorative glyphs are hidden by one spelling.** A glyph the control around
  it already names -- an icon, an emoji, a check box, pager dots -- spreads
  `decorativeHidden()` from `components/a11yHidden.ts`, on the glyph or on its
  wrapper, and so does UI on its way out of view (`decorativeHidden(!visible)`).
  It is `aria-hidden` on the web and the iOS and Android props on native; never
  hand-write `accessibilityElementsHidden`, `importantForAccessibility` (bar
  the un-grouping `"no"`) or `aria-hidden`, and never pass `accessible` to a
  lucide or react-native-svg element, whose web build forwards it to the DOM
  (#3009, #2829). `__tests__/wiring/decorativeHiddenGuard.test.ts` holds this.
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
- **Navigation owns the screen title.** When the stack header paints a
  screen's title, it is that screen's one title heading: the body neither
  paints the title again nor adds a header named by it, visible or not
  (`ScreenHeader` takes `titleHidden`), because on web both render as `h1` and
  a screen reader announces the title twice. The stack header is the title
  heading on every platform: iOS and web mark it natively, and Android, whose
  Toolbar title carries no heading, gets it through the header-role
  `headerTitle` in `NAV_SCREEN_OPTIONS` (`navigation/navScreenOptions.tsx`).
  The eyebrow and lead stay ordinary text (#2962). A body heading that says something else — a
  post-delete receipt, a form's own name that differs from the stack title —
  stays, as a header.

**Primitives** — reach for these before adding a bare `<Text>`:
`components/layout/ScreenHeader.tsx` (eyebrow → title → lead, right `action`
slot, `titleHidden` when navigation paints the title), `components/layout/EditorialSection.tsx` (titled band),
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

## Action rows (#2860)

Controls are where order is felt most: a person reaches for them. A button
"aligned with nothing at all, just scattered around" tells someone trying to
get their life in order that this place is not in order either. Five rules,
each one a reviewer can answer yes or no:

- **(a) One decline is the corner X.** A card with a single way to decline
  (set aside, dismiss, not now) declines with `ReflectionDismiss`
  `variant="close"` — an icon-only `lucide-react-native` X in `ink.soft`,
  `accent.primary` while pressed, pinned to the card's top-right corner with a
  hit area of at least `touchTarget.minimum` — never a text link on a line of
  its own. The card's content keeps clear of that corner (the morning-pages
  tip's `closeCornerReserve` is the precedent).
- **(b) Confirm and decline share one row.** A card that asks for a decision
  puts both controls in one right-aligned row at one height, with the decline
  as a `tertiary` `Button`.
- **(c) A form's primary action is placed, not left behind.** It is full-width
  or centred at the bottom of the form, never left-flush beneath a left-flush
  field label where it reads as one more label.
- **(d) No lone link under a card.** A text link never sits under a card on a
  line of its own; it joins a row (the card's own, or a row of its siblings)
  or becomes an icon.
- **(e) Siblings share one baseline and one edge.** Controls that belong
  together sit on one baseline and hang from one edge — all left or all right,
  never one of each.

**How to check** — `frontend/e2e/action-rows.browser.e2e.test.ts` walks every
route `e2e/routeWalk.ts` reaches (every tab and `RootStack` screen a lane
account can open; each one it cannot is listed with its reason) at 390x844
and 1280x720, reads every visible `accessibilityRole="button"` box in one
settled frame, prints one line per button (viewport, screen, `testID`, box,
name) and writes `frontend/e2e/artifacts/action-rows/<viewport>/<route>.{png,json}`,
which CI publishes as `action-row-sweep` on every run. Geometry holds three
of the rules' consequences as assertions: no two buttons overlap by more than
a pixel, no button leaves the viewport's width, and buttons side by side have
tops within 2px. Rules (a) to (e) themselves need judgement: they are the
reviewer's pass over those screenshots, screen by screen.

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
