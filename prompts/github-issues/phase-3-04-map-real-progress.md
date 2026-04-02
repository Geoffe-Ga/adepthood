# phase-3-04: Connect Map screen to real progress data

**Labels:** `phase-3`, `frontend`, `feature`, `priority-medium`
**Epic:** Phase 3 — Build Missing Features
**Depends on:** phase-2-03, phase-3-05
**Estimated LoC:** ~150–200

## Problem

The Map screen displays 10 stages but all data is hardcoded in `stageData.ts`:

```typescript
export const STAGES: StageData[] = Array.from({ length: 10 }, (_, index) => {
  const stageNumber = 10 - index;
  return {
    title: `Stage ${stageNumber}`,
    subtitle: `Subtitle ${stageNumber}`,
    progress: stageNumber === 1 ? 0.5 : 0,  // Only stage 1 has fake progress
    goals: [`Goal for stage ${stageNumber}`],
    practices: [`Practice for stage ${stageNumber}`],
  };
});
```

Stage titles are generic (`"Stage 1"`, `"Stage 2"`), subtitles are generic (`"Subtitle 1"`), progress is hardcoded (only stage 1 shows 0.5), and goals/practices are placeholder strings. The `stages` API client is imported and voided.

The modal that appears on stage tap has links to Practice and Course, but uses unsafe navigation: `navigation.navigate('Practice' as never)`.

## Scope

Connect the Map to real stage progress data and fix navigation.

## Tasks

1. **Replace hardcoded `STAGES` with API-fetched data**
   - On mount, call `stages.list()` (or `course.stages()` from phase-3-03)
   - Fall back to static data while loading
   - Map response to `StageData` interface

2. **Calculate real progress per stage**
   - Progress = composite of: habit completion in that stage + practice sessions + course content completed
   - Use the stage store from phase-2-03: `useStageStore().stages`
   - Each stage's progress is a number from 0 to 1

3. **Replace generic titles and subtitles**
   - Use real APTITUDE stage names: Beige ("Survival"), Purple ("Tribal"), Red ("Power"), Blue ("Order"), Orange ("Achievement"), Green ("Community"), Yellow ("Integration"), Turquoise ("Holistic"), Ultraviolet ("Transpersonal"), Clear Light ("Non-Dual")
   - These should come from the backend, but can be enriched on the frontend if needed

4. **Fix type-unsafe navigation**
   - Replace `navigation.navigate('Practice' as never)` with properly typed navigation
   - Use `RootTabParamList` from `BottomTabs.tsx` for type safety
   - Pass the selected stage number as a navigation parameter so Practice/Course screens can filter by stage

5. **Update stage modal content**
   - Show real goals for the stage (from habit data)
   - Show real practices for the stage
   - Show completion percentage
   - "Practice" and "Course" links navigate with stage context

6. **Delete static `stageData.ts` placeholder data** (or reduce to type definitions only)

## Acceptance Criteria

- Map shows real stage names and subtitles
- Progress bars reflect actual user progress
- Tapping a stage shows real goals and practices
- Navigation to Practice/Course is type-safe and passes stage context
- No `as never` type casts remain

## Files to Modify

| File | Action |
|------|--------|
| `frontend/src/features/Map/MapScreen.tsx` | Modify (API integration, typed nav) |
| `frontend/src/features/Map/stageData.ts` | Modify (reduce to types, remove hardcoded data) |
| `frontend/src/navigation/BottomTabs.tsx` | Modify (add stage param to Practice/Course routes) |
