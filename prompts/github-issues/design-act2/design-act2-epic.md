# Epic: Candle & Ink, Act II — compose the language into re-imagined, cohesive screens

**Labels:** `epic`, `frontend`, `ux`, `design`
**Scope:** Frontend only (shared design primitives + per-screen re-imagination)
**Estimated total LoC:** ~2,700 across 12 sub-issues

## Role

You are a senior React Native / product-design engineer with a strong visual
sense, working inside Adepthood's **warm-editorial "Candle & Ink"** language
(`surface` / `ink` / `accent`, the `type(width)` ramp, `surfaceShadow`,
`paperShadow` in `frontend/src/design/tokens.ts`). You make surfaces beautiful
**through the token system** — never with one-off magic numbers — and you treat
accessibility (WCAG 2.1 AA contrast, 44 dp touch targets, reduced-motion) as a
non-negotiable part of "beautiful," not an afterthought. You re-imagine
**layout, information architecture, and user story**, not just colour and
shadow.

## Goal

Wave one (epic **#798**) gave the app the *vocabulary* of a warm-editorial
language — semantic tokens (#799), an editorial type ramp (#800), shared
button/input primitives (#801), and warm grounds + soft elevation (#802). But a
vocabulary is not a composition. Today only **Habits** (the carefully-composed
reference screen) and the **Journal writing surface** actually *read* as
designed product. Everything else — the Journal shelf, Practice, Course, Map,
Auth, Settings — is "just vibes": functional layouts on legacy grey, with no
shared sense of rhythm, hierarchy, or arrival.

This epic is **Act II: composition.** It introduces the small set of structural
primitives the language is missing, then **re-imagines every non-Habits screen
end to end** — layout, IA, and user story — so the whole app feels like one
cohesive, professional product with a genuine UX *wow* factor. Habits is the
reference we codify and match, not a screen we touch.

### The aesthetic north star (clean-room)

The design direction is the warm, literary, editorial feel catalogued in the
[VoltAgent `awesome-design-md`](https://github.com/VoltAgent/awesome-design-md)
**Claude** entry — warm canvas, serif display headlines paired with a clean
sans, an accent reserved for scarce high-voltage moments, generous whitespace,
and a **light↔dark surface rhythm** that paces a screen. We take only the
**uncopyrightable structural ideas**, implemented clean-room on Adepthood's
**own** "Candle & Ink" palette:

- **No** third-party brand name, logo, mark, swatch, or font ships — the IP
  stance recorded in `frontend/src/design/DESIGN.md` + `ATTRIBUTION` (sub-issue
  #799) is binding. The warm cream is `surface.canvas` (`#faf6ef`); the accent
  is the app's own terracotta `accent.primary` (`#a5572f`), **not** anyone's
  coral.
- The "warm cream → dark product surface" pacing becomes **cream →
  warm-*umber* showcase** (a deep espresso, never navy) so it stays inside the
  candlelit world — see sub-issue 02.
- Serif display = `type(width).display`; sans body = `type(width).body`. The
  split is already in the ramp; this epic finally *uses* display type at hero
  scale outside the journal.

### What "just vibes" means today (the problem, with anchors)

- **No shared screen scaffold.** Each screen re-invents its header, padding, and
  section spacing. Habits earns its polish with a scale-aware `spacing(n, scale)`
  rhythm and pre-bound memoised rows; nobody else inherits that discipline.
- **No warm-dark showcase surface and no accent callout band.** `tokens.ts` has
  `surface.{canvas,raised,sunken,desk,hairline}` but nothing dark to pace
  against and no full-bleed accent moment. The light↔dark rhythm — the single
  biggest "designed product" signal in the north star — is impossible to build.
- **No Today / home hub and no program onboarding.** `BottomTabs.tsx:87-93`
  opens straight into Habits; there is no "what should I do today" surface and
  no welcome into the 36-week journey (`a7d95417` shell survey).
- **Practice** (`PracticeScreen.tsx`, `screens/*`) is entirely on legacy grey/
  brown (`colors.background.*`, `colors.text.secondary`); its completion moment
  is a silent colour change with no celebration.
- **Course** (`CourseScreen.tsx`, `Course.styles.ts`) is a plain white FlatList
  with hard `colors.border` rules — utilitarian, not a reading experience.
- **Journal shelf** reverts to grey search chrome (`SearchBar.tsx:142-201`) and
  a flat list with a bare empty state — orphaned from the warm Entry surface.
- **Map** (`MapScreen.tsx`) is visually rich but its *journey narrative* is weak
  — no sense of momentum, unlock timeline, or completion payoff.
- **Auth** (`auth.styles.ts`) is a grey-on-white centered form with no branded,
  editorial first impression of the program's tone.

## Output Format

Twelve independently-shippable sub-issues in three bands. **The three
foundation issues (01–03) are the critical path** — every screen issue imports
their primitives. After 01–03 land, 04–12 can proceed in parallel.

```
 FOUNDATION                         SCREENS (parallel after foundation)
 01 editorial-scaffolding ──┐        04 today-hub          08 course-immersive
 02 showcase-&-callout ─────┼──────► 05 journal-shelf      09 map-journey
 03 motion-&-empty-states ──┘        06 practice-catalog   10 auth-first-impression
                                     07 practice-player    11 settings-hub
 related (do not duplicate):         12 program-onboarding
   #803 editorial navigation chrome (tab bar + headers)
   #804 warm dark mode
```

## Sub-issues

| # | Title | Scope | Est. LoC |
|---|-------|-------|----------|
| 01 | [Editorial screen scaffold + section rhythm](design-act2-01-editorial-scaffolding.md) | Frontend | ~260 |
| 02 | [Warm-dark showcase surface + accent callout band](design-act2-02-showcase-surface-and-callout.md) | Frontend | ~220 |
| 03 | [Motion language + editorial empty / loading states](design-act2-03-motion-and-empty-states.md) | Frontend | ~240 |
| 04 | [Today hub — the editorial home tab](design-act2-04-today-hub.md) | Frontend | ~360 |
| 05 | [Journal shelf as an editorial library](design-act2-05-journal-shelf-library.md) | Frontend | ~240 |
| 06 | [Practice catalog + "begin a session" + warm adoption](design-act2-06-practice-catalog-and-begin.md) | Frontend | ~280 |
| 07 | [Immersive practice player + completion celebration](design-act2-07-practice-player-immersion.md) | Frontend | ~240 |
| 08 | [Course as an immersive reading experience](design-act2-08-course-immersive-reading.md) | Frontend | ~300 |
| 09 | [Map: a journey narrative with achievement](design-act2-09-map-journey-narrative.md) | Frontend | ~260 |
| 10 | [Auth as a branded editorial first impression](design-act2-10-auth-first-impression.md) | Frontend | ~230 |
| 11 | [Settings hub + warm adoption](design-act2-11-settings-hub.md) | Frontend | ~200 |
| 12 | [Program onboarding / welcome](design-act2-12-program-onboarding.md) | Frontend | ~280 |

## Acceptance Criteria (epic-level)

- [ ] Every screen is built from the shared `ScreenScaffold` / `ScreenHeader` /
      `EditorialSection` primitives (01); the whole app shares one header voice,
      one section rhythm, and one warm ground. No screen still hand-rolls its
      header + padding.
- [ ] The light↔dark **showcase** rhythm (02) appears as the hero moment on
      Today, the Practice player, the Course stage cover, and the Map/celebration
      surfaces — a deep warm umber, never navy, with AA-clearing on-showcase ink.
- [ ] A new **Today** tab (04) is the app's landing surface, aggregating today's
      habits, a practice to begin, journey position, and a journal nudge — no new
      backend, reusing existing stores/clients.
- [ ] Journal shelf (05), Practice (06–07), Course (08), Map (09), Auth (10),
      and Settings (11) are each re-imagined in **layout, IA, and user story** —
      not merely recoloured — and read as cohesive with Habits.
- [ ] Practice and Course are fully migrated off legacy grey
      (`colors.background.*` / `colors.text.secondary`) onto `surface`/`ink`/
      `accent`; no primary surface still renders flat `#f8f8f8`/`#ffffff` grey.
- [ ] Completion / arrival moments (practice complete, stage complete, goal
      reached) have a shared, reduced-motion-safe celebration (03) — not a silent
      colour swap.
- [ ] First run shows a program welcome (12) before the Today hub.
- [ ] **No regressions:** every existing test passes (testIDs, navigation
      routes, deep links, `RESONANCE_BUTTON_CLEARANCE`, mark-read guards).
- [ ] **No contrast regressions:** all text keeps WCAG 2.1 AA (≥ 4.5:1) on its
      ground; the token contrast tests stay green and gain coverage for the new
      showcase ground.
- [ ] All new styling flows from `tokens.ts`; `cd frontend && npm test &&
      npm run lint && npx tsc --noEmit` green; backend untouched; `pre-commit
      run --all-files` green on each PR.

## Constraints

- **Tokens only.** Every colour, radius, shadow, and spacing value comes from
  `tokens.ts`. No inline hex, no bare pixel constants in components (CLAUDE.md
  guardrail; enforced direction of #807-07).
- **Clean-room IP stance is binding.** No third-party brand name/logo/mark/
  swatch/font. Build on the app's own "Candle & Ink" palette; keep the
  `DESIGN.md` + `ATTRIBUTION` provenance intact and extend it for the new
  showcase tokens.
- **Re-imagine, don't just recolour.** Each screen issue must change layout / IA
  / user story, justified against the per-screen survey in its Problem section —
  not paint legacy layouts a warm colour.
- **Habits is the reference, not a target.** Do not modify the Habits feature;
  codify its patterns (responsive scale, memoised pre-bound rows, semantic
  surfaces, pre-calculated list layout) into the shared primitives instead.
- **Don't duplicate #803 / #804.** Navigation chrome (tab bar + stack headers)
  is owned by #803; warm dark *mode* by #804. Coordinate: the showcase tokens
  (02) must be authored so #804 can theme them; the Today tab (04) registers a
  route #803 will then theme.
- **Accessibility is part of the deliverable:** AA contrast on every ground
  (including the new showcase), 44 dp touch targets (`touchTarget.minimum`), and
  `prefers-reduced-motion` honoured by every animation.
- **React Native shadow portability:** specify both iOS/web shadow props and
  Android `elevation`; assert via `StyleSheet.flatten`, not snapshots.
- **TDD + thresholds** per CLAUDE.md (90 % line / 80 % branch). One logical
  change per PR; conventional commits (`feat(frontend): …`, `style(frontend):
  …`, `test(frontend): …`).

## References

- `frontend/src/design/tokens.ts` — `surface`/`ink`/`accent` (582-608),
  `type(width)` ramp (496-527), `surfaceShadow`/`paperShadow` (548-630),
  `spacing`/`SPACING` (245-263), `touchTarget` (340-342)
- `frontend/src/design/DESIGN.md` + `ATTRIBUTION` — the language + IP stance
- `frontend/src/features/Habits/` — the gold-standard reference (HabitsScreen,
  HabitTile, HabitsEmptyState, useResponsive)
- `frontend/src/navigation/BottomTabs.tsx:87-93,144` — current 5-tab shell
- Epic #798 and sub-issues #799-#804 — wave-one vocabulary (this epic's base)
