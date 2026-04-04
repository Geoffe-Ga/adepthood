# phase-2-02: Replace three mode booleans with a single mode enum

**Labels:** `phase-2`, `frontend`, `refactor`, `priority-high`
**Epic:** Phase 2 — Decompose the Monolith
**Estimated LoC:** ~80–100

## Problem

HabitsScreen tracks three mutually exclusive UI modes with three separate boolean states:

```tsx
const [statsMode, setStatsMode] = useState(false);
const [quickLogMode, setQuickLogMode] = useState(false);
const [editMode, setEditMode] = useState(false);
```

These are set independently, creating the possibility of impossible states (e.g., `statsMode: true, editMode: true` simultaneously). The menu handlers carefully set one true and the others false:

```tsx
setQuickLogMode(true);
setStatsMode(false);
setEditMode(false);
```

This pattern is repeated 4 times (once for each mode + once for exit). It's verbose, error-prone, and adds 12 lines of code where 1 line would suffice.

## Scope

Replace three booleans with a single discriminated union type.

## Tasks

1. **Define the mode type in `Habits.types.ts`**
   ```typescript
   export type HabitScreenMode = 'normal' | 'stats' | 'quickLog' | 'edit';
   ```

2. **Replace state in the hook (or HabitsScreen if phase-2-01 isn't done yet)**
   ```typescript
   const [mode, setMode] = useState<HabitScreenMode>('normal');
   ```

3. **Update all mode checks**
   - `statsMode` becomes `mode === 'stats'`
   - `quickLogMode` becomes `mode === 'quickLog'`
   - `editMode` becomes `mode === 'edit'`

4. **Update menu handlers**
   - Replace 3-line setter blocks with single calls: `setMode('stats')`, `setMode('quickLog')`, `setMode('edit')`
   - Exit button: `setMode('normal')`

5. **Update tile press handler** (lines 482-492)
   ```tsx
   // Before:
   if (statsMode) { ... }
   else if (editMode) { ... }
   else if (quickLogMode) { ... }
   else { ... }

   // After:
   switch (mode) {
     case 'stats': ...; break;
     case 'edit': ...; break;
     case 'quickLog': ...; break;
     default: ...; break;
   }
   ```

6. **Update mode indicator bar** (lines 617-636)
   - Replace ternary chain with a lookup object or switch

## Acceptance Criteria

- Impossible states (multiple modes true) are eliminated by the type system
- All mode switching works identically
- Code is shorter and more readable
- No behavioral changes

## Files to Modify

| File | Action |
|------|--------|
| `frontend/src/features/Habits/Habits.types.ts` | Modify (add HabitScreenMode type) |
| `frontend/src/features/Habits/HabitsScreen.tsx` | Modify (replace booleans with enum) |
