# audit-ux-04: Add real error + retry states to the Course screen

**Labels:** `audit-ux`, `frontend`, `ux`, `priority-medium`
**Epic:** UX States, Accessibility & Error Copy
**Estimated LoC:** ~230  (hard cap 700)

## Problem

`CourseScreen.tsx:53-143` swallows fetch failures into empty/loading fallbacks. In `useCourseStages` the stage-list `catch` (`:53-57`) only `console.error`s and leaves `allStages` empty. In `useStageContent` the content `catch` (`:81-87`) resets `setContent([])` and `setProgress(null)`. Downstream, `CourseEmptyState` (`:146`) renders "No Content Yet" whenever content is empty, and `CourseProgressBar` (`:124-143`) shows a permanent "Loading..." label when `progress === null`. So a real fetch failure masquerades as either an empty course or a forever-loading bar, with no error message and no retry. Current state: this is a **UX correctness** defect (error masked as empty/loading); the user cannot distinguish "broken" from "no content yet" and cannot recover (audit §8 `Course/CourseScreen.tsx:53-143`, §2.8).

## Scope

**Covers:** Adding an explicit `error` flag to both `useCourseStages` and `useStageContent`, and rendering a distinct error+retry UI that supersedes the empty/loading fallbacks when a fetch actually failed.

**Does NOT:** Change the chapter reader, mark-as-read flow, stage-derivation logic, or backend endpoints. The genuinely-empty path keeps its existing "No Content Yet" copy.

## Tasks

1. **Track stage-list error** — In `useCourseStages`, add an `error` state set in the `catch` (`:53-57`) and clear it on a successful load; expose it (and a retry that re-runs `init`) from the hook. TDD: when `stagesApi.listAll` rejects, the hook exposes a truthy `error`; calling retry re-invokes the API.
2. **Track content/progress error** — In `useStageContent`, add an `error` state set in the `catch` (`:81-87`) alongside the existing resets, and expose a retry bound to `refreshContent`. TDD: when either `stageContentAll` or `stageProgress` rejects, `error` is truthy and retry re-runs `refreshContent`.
3. **Render an error+retry state** — Add a `CourseErrorState` component (error copy + "Try again" button, `accessibilityRole="button"`) and render it in place of `CourseEmptyState`/the "Loading..." progress label when the corresponding `error` is set. TDD: on stage-list failure the screen shows the error+retry UI, not "No Content Yet"; on content failure likewise; pressing retry clears it on a subsequent success.
4. **Error copy review** — Apply the `user-facing-error-messages` rubric (what / why / next); no `error.message`, status code, or snake_case code in the copy. Keep the empty-state copy for the true-empty path.

## Acceptance Criteria

- [ ] A failed stage-list fetch renders an error+retry state, not the empty state.
- [ ] A failed content/progress fetch renders an error+retry state, not "No Content Yet" / permanent "Loading...".
- [ ] A genuinely empty stage still shows "No Content Yet"; a still-loading stage still shows the spinner/loading label.
- [ ] Retry re-runs the fetch and clears the error on success.
- [ ] No user-facing copy leaks internals.
- [ ] No existing tests break; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on --all-files.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Course/CourseScreen.tsx` | Modify (error state + retry UI) |
| `frontend/src/features/Course/__tests__/CourseErrorStates.test.tsx` | **Create** |
