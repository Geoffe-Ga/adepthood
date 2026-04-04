# phase-3-13: Connect Map to real progress with rich stage metadata

**Labels:** `phase-3`, `frontend`, `feature`, `priority-medium`
**Epic:** Phase 3 — Build Missing Features
**Depends on:** phase-2-03, phase-3-01
**Estimated LoC:** ~200–250

## Problem

The Map screen displays 10 stages but all data is hardcoded in `stageData.ts` with generic titles (`"Stage 1"`, `"Subtitle 1"`) and fake progress (`stageNumber === 1 ? 0.5 : 0`).

The spec provides detailed stage definitions:

> 1. Beige: Survival, "Active Yes-And-Ness"
> 2. Purple: Magick, "Receptive Yes-And-Ness"
> 3. Red: Power, "Self-Love"
> 4. Blue: Conformity, "Universal Love"
> 5. Orange: Achievist, "Intellectual Understanding"
> 6. Green: Pluralist, "Embodied Understanding"
> 7. Yellow: Integrative, "Systems Wisdom"
> 8. Teal: Nondual, "Transcendent Wisdom"
> 9. Ultraviolet: Effortless Being, "Unity of Being"
> 10. Clear Light: Pure Awareness, "Emptiness and Awareness"

The `CourseStage` model has rich metadata: `spiral_dynamics_color`, `growing_up_stage`, `divine_gender_polarity`, `relationship_to_free_will`, `free_will_description`.

The spec also requires:
> "Make each stage clickable to reveal detailed information (like links to the Course material) and a library of infographics"
> "Illustrate relationships between stages with lines or arcs that emphasize continuity and evolution"
> "Use smooth animations for transitions between stages"
> "Quick Actions: Add buttons to 'Go to Course' or 'Open Journal' directly from the Map"

## Scope

Replace hardcoded data with API data and build the rich stage detail panel.

## Tasks

1. **Fetch stages from API on mount**
   - Replace hardcoded `STAGES` array with data from `stages.list()` API
   - Use stage store from phase-2-03
   - Each stage includes: real title, subtitle, spiral_dynamics_color, progress

2. **Update stage modal with rich metadata**
   - Currently shows: title, subtitle, progress bar, Practice/Course links
   - Add: growing_up_stage, relationship_to_free_will, free_will_description
   - Add: "Open Journal" button (spec requirement for quick actions)
   - Show associated habits for the stage (from habit store)
   - Show practice completion status for the stage

3. **Fix navigation type safety**
   - Replace `navigation.navigate('Practice' as never)` with typed navigation
   - Pass `stageNumber` to Practice and Course when navigating from Map
   - Add "Open Journal" navigation with `stageReflection: true`

4. **Add visual improvements per spec**
   - Stage connections: draw lines/arcs between stages on the background
   - Animated transitions when opening/closing stage modal
   - Completed stages should glow or have a checkmark
   - Current stage should be highlighted/pulsing
   - Locked stages dimmed with lock icon

5. **Reduce `stageData.ts` to types only**
   - Keep `StageData` and `Hotspot` interfaces
   - Remove hardcoded `STAGES` array and `COLORS` array
   - Hotspot positions can remain static (they map to the background image)

6. **Update styles for "mystical and aspirational aesthetic with thematic colors and symbolic designs"**

## Acceptance Criteria

- Map shows real stage names, subtitles, and metadata from API
- Progress bars reflect actual user progress
- Stage detail modal shows full metadata + quick links to Course, Practice, Journal
- Navigation is type-safe with stage context passed
- Visual polish: animations, connections, glow effects
- No `as never` type casts

## Files to Modify

| File | Action |
|------|--------|
| `frontend/src/features/Map/MapScreen.tsx` | Rewrite |
| `frontend/src/features/Map/stageData.ts` | Reduce to types + hotspot positions |
| `frontend/src/features/Map/Map.styles.ts` | Rewrite |
| `frontend/src/navigation/BottomTabs.tsx` | Modify (route params) |
