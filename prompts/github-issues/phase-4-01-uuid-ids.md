# phase-4-01: Replace Math.random() IDs with UUID generation

**Labels:** `phase-4`, `frontend`, `bug`, `priority-medium`
**Epic:** Phase 4 — Polish & Harden
**Estimated LoC:** ~50

## Problem

Completion objects are created with `Math.random()` as their ID:

```tsx
// HabitUtils.ts:239
const completion: Completion = {
  id: Math.random(),  // e.g., 0.7234567890123456
  timestamp: date,
  completed_units: amount,
};

// HabitsScreen.tsx:375
const newCompletions = days.map((day) => ({
  id: Math.random(),
  timestamp: day,
  completed_units: 1,
}));
```

**Why this is a problem:**
- `Math.random()` produces floats like `0.723456...` — these are not valid IDs in any database
- Collisions are possible (~1 in 2^52, but still non-zero)
- When these completions are sent to the backend, the server expects integer IDs
- `ReorderHabitsModal.tsx` uses `Math.random()` as a fallback keyExtractor — React will warn about duplicate keys if two items get the same value

## Scope

Install a UUID library and use it for all client-generated IDs.

## Tasks

1. **Install `uuid` package**
   - `npm install uuid`
   - `npm install -D @types/uuid`

2. **Replace all `Math.random()` ID generation**
   - `HabitUtils.ts:239` — `id: uuidv4()`
   - `HabitsScreen.tsx:375` — `id: uuidv4()`
   - `ReorderHabitsModal.tsx` — keyExtractor fallback

3. **Update the `Completion` type**
   - Change `id?: number` to `id?: string` (UUIDs are strings)
   - Or keep as `number` if the backend assigns integer IDs, and use a temporary client-side UUID that gets replaced when the server responds

4. **Decide on ID strategy**
   - Option A: Client generates UUID strings, backend stores them as-is
   - Option B: Client generates temporary UUIDs, backend assigns integer IDs, client updates on sync
   - Recommendation: Option A is simpler — use UUIDs everywhere

## Acceptance Criteria

- No `Math.random()` used for ID generation anywhere in the codebase
- All IDs are unique and valid
- React key warnings eliminated
- ID type is consistent between frontend and backend

## Files to Modify

| File | Action |
|------|--------|
| `frontend/src/features/Habits/HabitUtils.ts` | Modify |
| `frontend/src/features/Habits/HabitsScreen.tsx` | Modify |
| `frontend/src/features/Habits/components/ReorderHabitsModal.tsx` | Modify |
| `frontend/src/features/Habits/Habits.types.ts` | Modify (update id type) |
| `frontend/package.json` | Modify (add uuid, @types/uuid) |
