# phase-2-03: Create global state layer for cross-screen data sharing

**Labels:** `phase-2`, `frontend`, `architecture`, `priority-high`
**Epic:** Phase 2 — Decompose the Monolith
**Depends on:** phase-1-10 (AuthContext)
**Estimated LoC:** ~200–250

## Problem

`AppContext.tsx` is an empty file. All app state lives inside individual screen components with no way to share data between tabs. This causes real problems:

- **Map screen** can't know what habits exist or what stage the user is on
- **Practice screen** can't know which stage's practice to show
- **Journal screen** can't reference current habits or progress
- **Course screen** can't know stage completion status

Each screen would need to independently fetch all the data it needs from the API, with no shared cache. This leads to redundant network requests, inconsistent UI (one tab shows stale data), and no way to coordinate actions across tabs (e.g., completing a practice updates the map).

## Scope

Implement a lightweight global state solution. Zustand is recommended over Redux for this project size — it's ~1KB, has no boilerplate, and integrates cleanly with React hooks.

## Tasks

1. **Install Zustand**
   - `npm install zustand`
   - Or alternatively, build with React Context + `useReducer` if you prefer zero dependencies

2. **Create `frontend/src/store/useHabitStore.ts`**
   - State: `habits: Habit[]`, `selectedHabit: Habit | null`, `isLoading: boolean`, `error: string | null`
   - Actions: `fetchHabits()`, `createHabit()`, `updateHabit()`, `deleteHabit()`, `logCompletion()`
   - These actions call the API and update the store
   - The store replaces the `useState` calls in HabitsScreen

3. **Create `frontend/src/store/useStageStore.ts`**
   - State: `stages: StageData[]`, `currentStage: number`
   - Derived: `stageProgress` computed from habit completions
   - Actions: `fetchStages()`, `updateProgress()`

4. **Create `frontend/src/store/useUserStore.ts`**
   - State: `user: User | null`, `preferences: UserPreferences`
   - Actions: `updatePreferences()`
   - AuthContext handles login/logout; this store handles profile data

5. **Migrate HabitsScreen to use the store**
   - Replace `const [habits, setHabits] = useState<Habit[]>(DEFAULT_HABITS)` with `const { habits, fetchHabits } = useHabitStore()`
   - Replace handler functions with store actions
   - The screen becomes a consumer of global state, not the owner

6. **Migrate MapScreen to use the store**
   - Replace hardcoded `STAGES` with `useStageStore().stages`
   - Replace `progress: stageNumber === 1 ? 0.5 : 0` with real data

7. **Add Zustand persist middleware for AsyncStorage integration**
   - `zustand/middleware` has a `persist` option
   - Configure it to use AsyncStorage — this can replace the manual persistence layer from phase-1-09, or work alongside it

## Acceptance Criteria

- Habit data is accessible from any screen without prop drilling
- Updating a habit on the Habits tab is reflected on the Map tab immediately
- Stage progress is shared between Map and Course screens
- Stores are testable independently of components
- No unnecessary re-renders (Zustand's selector pattern)

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/store/useHabitStore.ts` | **Create** |
| `frontend/src/store/useStageStore.ts` | **Create** |
| `frontend/src/store/useUserStore.ts` | **Create** |
| `frontend/src/features/Habits/HabitsScreen.tsx` | Modify (consume store) |
| `frontend/src/features/Map/MapScreen.tsx` | Modify (consume store) |
| `frontend/src/context/AppContext.tsx` | **Delete** (replaced by stores) |
| `frontend/package.json` | Modify (add zustand) |
