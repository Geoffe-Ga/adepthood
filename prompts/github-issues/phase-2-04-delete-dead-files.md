# phase-2-04: Delete all dead/empty files and unused code

**Labels:** `phase-2`, `frontend`, `backend`, `cleanup`, `priority-medium`
**Epic:** Phase 2 — Decompose the Monolith
**Estimated LoC:** ~50 removed (net negative)

## Problem

The codebase contains multiple empty files, unused components, and orphaned code that create confusion about what's real and what's placeholder. Every empty file is a question mark for a new developer: "Is this in progress? Was it abandoned? Should I use it?"

## Inventory of Dead Code

### Empty Files (0-1 lines of real content)
| File | Contents | Verdict |
|------|----------|---------|
| `frontend/src/context/AppContext.tsx` | 1 line (empty) | Delete (replaced by stores in phase-2-03) |
| `frontend/src/features/Habits/HabitCard.tsx` | 1 line (empty) | Delete (HabitTile.tsx is used instead) |
| `frontend/src/features/Habits/HabitCard.styles.ts` | 1 line (empty) | Delete (companion to unused HabitCard) |
| `frontend/src/features/Habits/hooks.ts` | 1 line (empty) | Delete (replaced by hooks/ dir in phase-2-01) |
| `frontend/src/services/habitsApi.ts` | 1 line (empty) | Delete (api/index.ts is the client) |
| `frontend/src/styles/colors.ts` | Empty | Delete (colors defined elsewhere) |

### Never-Used Components
| File | Contents | Verdict |
|------|----------|---------|
| `frontend/src/components/Button/Button.tsx` | Full component (~50 lines) | Delete (never imported by any screen) |
| `frontend/src/components/Button/Button.styles.ts` | Full styles | Delete (companion to unused Button) |
| `frontend/src/services/energyApi.ts` | Wraps deleted client.ts | Delete (phase-1-07 removes client.ts) |

### `void` Import Hacks (removed in phase-1-07, verify here)
Confirm these are gone:
- `void habits;` in HabitsScreen.tsx
- `void journal;` in JournalScreen.tsx
- `void practice;` in PracticeScreen.tsx
- `void stages;` in MapScreen.tsx

## Tasks

1. **Delete all files listed above**
2. **Remove any imports of deleted files** — search for `import.*HabitCard`, `import.*Button`, `import.*habitsApi`, `import.*energyApi`, `import.*colors`, `import.*AppContext`
3. **Check for orphaned test files** — if any test imports a deleted module, update or delete the test
4. **Run the full test suite** to confirm nothing breaks
5. **Run TypeScript compiler** (`npx tsc --noEmit`) to catch any broken imports

## Acceptance Criteria

- No empty files remain in the codebase
- No unused components exist
- `npx tsc --noEmit` passes
- All tests pass
- `git diff --stat` shows net negative lines

## Files to Delete

| File | Action |
|------|--------|
| `frontend/src/context/AppContext.tsx` | **Delete** |
| `frontend/src/features/Habits/HabitCard.tsx` | **Delete** |
| `frontend/src/features/Habits/HabitCard.styles.ts` | **Delete** |
| `frontend/src/features/Habits/hooks.ts` | **Delete** |
| `frontend/src/services/habitsApi.ts` | **Delete** |
| `frontend/src/services/energyApi.ts` | **Delete** |
| `frontend/src/styles/colors.ts` | **Delete** |
| `frontend/src/components/Button/Button.tsx` | **Delete** |
| `frontend/src/components/Button/Button.styles.ts` | **Delete** |
