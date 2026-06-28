# course-cms-05: Course screen — render the stage-introduction card

**GitHub:** #721 · **Labels:** `frontend`, `enhancement`
**Epic:** #716 · **Depends on:** #720 (client + reader source)
**Estimated LoC:** ~220

## Problem

`CourseScreen` shows stage metadata, the "From Aptitude Guru" site-resource
chips, a progress bar, and the drip-fed chapter list — but nothing surfaces the
**stage introduction** (the Google-Docs "start here" reading). Add a
stage-introduction card at the top of the stage that opens the intro in the
native-Markdown `ChapterReader`.

## Scope

`CourseScreen.tsx` + a small `StageIntroCard` component + styles + tests. Reuse
the `useCourseViewer` overlay pattern and the `ChapterReader` `intro` source
from #720.

## Tasks (TDD)

1. **Loader.** Load the selected stage's intro alongside the existing content
   load (in `useStageContent` or a sibling hook): call
   `courseApi.stageIntro(selectedStage)`. A 404 (no intro / locked) is **not** an
   error — store `intro = null` and render nothing, mirroring how
   `SiteResourcesPanel` silently hides when empty. Reset on stage change.
2. **Card.** Add `StageIntroCard` (own file or co-located) showing the intro
   `title` and `summary` with a clear "Introduction" affordance; `testID="stage-intro-card"`,
   `accessibilityRole="button"`, 44dp touch target. Render it **above** the
   chapter `FlatList` (e.g. as a `ListHeaderComponent` or above `ContentArea`),
   below `StageMetadata`/progress.
3. **Open in reader.** Extend `useCourseViewer` with a `viewingIntro` stage and a
   handler; `renderOverlay` opens
   `<ChapterReader source={{ kind: 'intro', stageNumber }} fallbackTitle={intro.title} onBack={...} />`.
   (Optional, only if trivial: a "Reflect" deep-link like chapters — otherwise
   leave intros read-only.)
4. **Tests.** Extend `CourseScreen.test.tsx` (+ a `StageIntroCard` test):
   - stage with an intro → card renders title/summary;
   - tapping the card opens `ChapterReader` with an `intro` source;
   - stage with no intro (API 404 / null) → no card, no error banner, chapters
     still render;
   - switching stages refetches the intro;
   - existing CourseScreen tests (empty/error/locked, site resources, progress)
     stay green.

## Acceptance criteria

- A stage-introduction card appears above the chapter list when the stage has an
  intro, and opens it in the native reader.
- No card and no error when the stage has no intro (graceful, like the resources
  panel).
- Chapters, drip-feed, progress, error/empty states, and the "From Aptitude
  Guru" panel are unchanged.
- All styling from `design/tokens` (no magic numbers / inline hex).
- `cd frontend && npm test && npm run lint && npx tsc --noEmit` all pass.

## Files to modify

| File | Action |
|------|--------|
| `frontend/src/features/Course/CourseScreen.tsx` | Load intro, render card, open overlay |
| `frontend/src/features/Course/StageIntroCard.tsx` | New card component |
| `frontend/src/features/Course/Course.styles.ts` | Card styles (tokens only) |
| `frontend/src/features/Course/__tests__/CourseScreen.test.tsx` | New cases |
| `frontend/src/features/Course/__tests__/StageIntroCard.test.tsx` | New test |

## Constraints

- A missing intro is a normal state, never an error surface.
- Reuse `ChapterReader` (intro source) — do not render Markdown inline here.
- Tokens only; preserve every existing Course `testID`.
