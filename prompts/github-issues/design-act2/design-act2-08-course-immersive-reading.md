# design-act2-08: Course as an immersive reading experience

**Labels:** `frontend`, `ux`, `design`
**Epic:** [Candle & Ink, Act II](design-act2-epic.md)
**Depends on:** 01 (scaffold), 02 (showcase), 03 (empty/celebration)
**Estimated LoC:** ~300

## Problem

The Course screen is the most utilitarian surface in the app. It is a plain
white `FlatList` of cards on a grey ground with hard `colors.border` rules
(`Course.styles.ts`, `borderBottomColor: colors.border` appears 5×), no warm
adoption, no visual hierarchy, and no reading-experience craft (`a308cecd`
survey). Concretely:

- The stage selector is a utilitarian pill row (`StageSelector.tsx`) divided by
  `colors.border`; selecting a stage has no momentum or sense of *entering a
  chapter*.
- Content cards (`ContentCard.tsx`) are icon + title + subtitle with no
  type/visual differentiation between essay / prompt / video, and the list has no
  breathing room (`CourseScreen.tsx:214-254`).
- The `ChapterReader` (`ChapterReader.tsx`) renders markdown competently but on a
  flat ground — it is not the immersive "page" the journal proves the app can do.
- Stage completion is a numeric progress bar (`:145-167`) with no payoff.

## Scope

Re-imagine Course as an inviting, paced reading experience: a stage "cover," an
editorial reading list, an immersive chapter reader on a paper sheet, and a
celebratory stage-completion. Adopt the warm tokens throughout. Preserve all
content/drip-feed/mark-read/intro behaviour exactly (`ContentViewer.tsx` guards,
release-day gating, the 404-mask).

## Tasks

### 1. Stage cover (showcase)

- Replace the bare stage-metadata band with a **stage cover** `ShowcaseCard`: the
  stage name in serif `type().display` (`onShowcase.primary`), the Spiral-Dynamics
  colour as an accent rule, the stage type + a one-line orientation, and the
  stage progress rendered as a refined arc on the umber. Keep the
  `StageSelector` but warm it (drop the `colors.border` dividers; selected stage
  reads as "current chapter").

### 2. Editorial reading list

- Adopt `ScreenScaffold` + `EditorialSection` ("Start here" for the intro card,
  "Chapters" for the drip list). Lift the stage-intro card and content cards onto
  `surface.raised` with `surfaceShadow.card` and real spacing rhythm.
- Differentiate content types in `ContentCard.tsx` with a serif title + a typed
  caption + a quiet type glyph; locked/read/unread states stay but read warmly
  (✓ read in `accent`, 🔒 locked muted). Empty content → shared `EmptyState`.

### 3. Immersive chapter reader

- Float the `ChapterReader` body on a centred paper **sheet** (reuse the journal's
  `paperShadow.sheet` + a comfortable reading measure) over the warm desk ground,
  with serif headings and a clean reading rhythm. Keep the markdown rules, the
  vendored-image handling, the "Mark as Read" + conditional "Reflect in Journal"
  footer, and the mounted-ref mark-read guard (`ContentViewer.tsx:73-92`) intact.

### 4. Stage completion payoff

- When a stage reaches 100 %, play the shared `Celebration` (issue 03) and show a
  warm "Stage complete" beat above the progress arc.

## Tasks — tests

- `CourseScreen.test.tsx`: stage cover renders on the showcase with a serif stage
  name; sections render; content cards differentiate by type; warm tokens only
  (no `colors.border` dividers on the primary surfaces); stage/intro/resources
  data flows unchanged.
- `ChapterReader.test.tsx` / `ContentViewer.test.tsx`: body renders on the sheet;
  mark-read + reflect-in-journal + the mounted-ref guard behaviour unchanged.
- Completion path fires `Celebration` at 100 %.

## Acceptance Criteria

- Course reads as an inviting reading experience: a showcase stage cover, an
  editorial reading list, and an immersive paper-sheet chapter reader.
- All content behaviour (drip-feed gating, mark-read, intro tier, site resources,
  404-mask) is preserved exactly; stage completion celebrates.
- Course is fully off legacy grey; no hard `colors.border` rules on primary
  surfaces; no magic numbers. `cd frontend && npm test && npm run lint &&
  npx tsc --noEmit` green.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Course/CourseScreen.tsx` | Modify — scaffold, stage cover, sections |
| `frontend/src/features/Course/Course.styles.ts` | Modify — warm tokens, drop grey rules |
| `frontend/src/features/Course/StageSelector.tsx` | Modify — warm "current chapter" |
| `frontend/src/features/Course/ContentCard.tsx` | Modify — type differentiation |
| `frontend/src/features/Course/ChapterReader.tsx` | Modify — paper sheet reader |
| `frontend/src/features/Course/__tests__/*.test.tsx` | Modify |
