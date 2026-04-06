# EPIC: Phase 5 — Prompt Alignment & UX Refinement

**Labels:** `epic`, `phase-5`, `priority-medium`

## Summary

A cross-reference of the original feature prompts against the current implementation revealed seven discrepancies where the prompt's original vision is richer or more intentional than what was built. These issues address UX gaps in habit visualization, milestone celebration, progress feedback, map richness, journal extensibility, and energy scaffolding polish.

None of these are functional bugs — the app works. But they represent moments where the original design intent was stronger than the shipped experience: locked habits that should inspire rather than hide, milestones that should celebrate rather than interrupt, and progress bars that should communicate state at a glance.

## Success Criteria

- All 10 habit tiles always visible; locked ones are greyed out with a padlock icon
- Milestone achievements use non-blocking toast notifications, not modal alerts
- Progress bar uses a victory color when goals are met (both additive and subtractive)
- Map stage detail modal includes past practices and goal history
- Journal tags use an extensible enum/string model instead of boolean columns
- Energy Scaffolding flow includes a reveal animation for the sorted habit order
- Users can manually unlock habits via a settings override

## Sub-Issues

1. `phase-5-01` — Show locked habits as greyed-out tiles instead of hiding them
2. `phase-5-02` — Replace milestone Alert.alert() with toast notifications
3. `phase-5-03` — Add victory color system to progress bars
4. `phase-5-04` — Add past practices and goals to Map stage detail modal
5. `phase-5-05` — Migrate journal tags from booleans to extensible enum
6. `phase-5-06` — Add reveal animation to Energy Scaffolding reorder step
7. `phase-5-07` — Add manual habit unlock override setting

## Dependency Graph

```
No dependencies on each other — all 7 issues can run in parallel.

External dependencies (from prior phases):
  All issues assume Phases 1–4 are complete.

  phase-5-01 (Greyed tiles) — standalone, touches HabitsScreen + HabitTile
  phase-5-02 (Toasts) — standalone, touches useHabits hook
  phase-5-03 (Victory color) — standalone, touches HabitUtils + HabitTile
  phase-5-04 (Map history) — standalone, touches MapScreen + stages API
  phase-5-05 (Journal tags) — standalone, touches journal model + router + frontend
  phase-5-06 (Scaffolding reveal) — standalone, touches OnboardingModal
  phase-5-07 (Manual unlock) — standalone, touches useHabits + settings UI
```

## Parallelism Notes

All 7 issues are **fully independent** — they touch different files and different features. They can all be worked on simultaneously without merge conflicts:

- **5-01, 5-02, 5-03, 5-06, 5-07** are Habits-scoped but touch non-overlapping files
- **5-04** is Map-scoped
- **5-05** is Journal-scoped (full-stack)
