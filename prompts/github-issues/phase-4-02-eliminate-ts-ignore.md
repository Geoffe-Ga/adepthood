# phase-4-02: Eliminate all @ts-ignore and type-unsafe casts

**Labels:** `phase-4`, `frontend`, `typescript`, `priority-medium`
**Epic:** Phase 4 — Polish & Harden
**Estimated LoC:** ~100–150

## Problem

The codebase has multiple `@ts-ignore` comments and `as never` casts that bypass TypeScript's type safety. Each one is a place where the compiler can't catch bugs:

**`@ts-ignore` instances:**
- `HabitTile.tsx:218-220, 350-352` — Suppressing errors for `react-native-web` hover props (4 instances). These are non-standard props that only exist on web but TypeScript doesn't know about them.
- `HabitsScreen.tsx:701` — `EmojiSelector` component has incomplete type definitions
- `GoalModal.tsx:29` — Percentage-based positioning style

**`as never` casts:**
- `MapScreen.tsx:112-113` — `navigation.navigate('Practice' as never)` — bypasses the typed navigation system entirely

**`as` type assertions:**
- `HabitUtils.ts:127` — `as [Goal, Goal, Goal]` — assumes exactly 3 goals, no runtime check

**`eslint-disable` suppressions:**
- `Habits.types.ts:1` — `/* eslint-disable no-unused-vars */` — blanket rule disable at file level to allow interface definitions with unused parameter names (the `_` prefix convention in callback types like `onUpdate: (_updatedHabit: Habit) => void`)

## Scope

Fix each suppression with proper types instead of bypassing the compiler.

## Tasks

1. **Fix react-native-web hover props** (HabitTile.tsx)
   - Create a `WebViewProps` type extension or use `Platform.OS === 'web'` conditional
   - Or add a `react-native-web.d.ts` type augmentation file that extends `ViewProps` with `onMouseEnter`/`onMouseLeave`
   - This is the right way to handle platform-specific props

2. **Fix EmojiSelector typing** (HabitsScreen.tsx:701)
   - Install `@types/react-native-emoji-selector` if available
   - Or create a `react-native-emoji-selector.d.ts` declaration file:
     ```typescript
     declare module 'react-native-emoji-selector' {
       interface EmojiSelectorProps {
         onEmojiSelected: (emoji: string) => void;
         showSearchBar?: boolean;
         columns?: number;
         emojiSize?: number;
       }
       export default function EmojiSelector(props: EmojiSelectorProps): JSX.Element;
     }
     ```

3. **Fix percentage positioning** (GoalModal.tsx:29)
   - React Native's `top` style accepts `number | string` — but the TypeScript types for RN don't allow percentage strings in some versions
   - Fix: use `DimensionValue` type from React Native, or calculate pixel values from `useWindowDimensions()`

4. **Fix navigation typing** (MapScreen.tsx:112)
   - Already addressed in phase-3-04, but verify: use `useNavigation<BottomTabNavigationProp<RootTabParamList>>()`
   - This makes `navigation.navigate('Practice')` type-safe without any casts

5. **Fix Goal array assertion** (HabitUtils.ts:127)
   - Add a runtime check: `if (sortedGoals.length !== 3) throw new Error(...)` before the destructure
   - Or use safer indexing: `const lowGoal = sortedGoals[0]; if (!lowGoal) return defaultResult;`

6. **Fix eslint-disable in types file**
   - The `_` prefix convention for callback parameter names is actually fine — configure ESLint to ignore parameters starting with `_`:
     ```json
     "no-unused-vars": ["error", { "argsIgnorePattern": "^_" }]
     ```
   - Then remove the blanket `eslint-disable` comment

7. **Create `frontend/@types/` directory** for custom type declarations
   - Move the `react-test-renderer.d.ts` file that already exists in `frontend/@types/` here
   - Add new declaration files created in this issue

## Acceptance Criteria

- Zero `@ts-ignore` comments in the codebase
- Zero `as never` casts
- All type suppressions replaced with proper type definitions
- `npx tsc --noEmit` passes cleanly
- ESLint passes without blanket disables

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/@types/react-native-web.d.ts` | **Create** |
| `frontend/@types/react-native-emoji-selector.d.ts` | **Create** |
| `frontend/src/features/Habits/HabitTile.tsx` | Modify (remove @ts-ignore) |
| `frontend/src/features/Habits/HabitsScreen.tsx` | Modify (remove @ts-ignore) |
| `frontend/src/features/Habits/components/GoalModal.tsx` | Modify (remove @ts-ignore) |
| `frontend/src/features/Habits/HabitUtils.ts` | Modify (safe array access) |
| `frontend/src/features/Habits/Habits.types.ts` | Modify (remove eslint-disable) |
| `frontend/src/features/Map/MapScreen.tsx` | Modify (typed navigation) |
| `frontend/eslint.config.cjs` | Modify (argsIgnorePattern) |
