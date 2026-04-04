# phase-4-05: Add type-safe navigation throughout the app

**Labels:** `phase-4`, `frontend`, `typescript`, `priority-low`
**Epic:** Phase 4 — Polish & Harden
**Depends on:** phase-3-04
**Estimated LoC:** ~100

## Problem

Navigation is minimally typed. `BottomTabs.tsx` defines `RootTabParamList` but most screens don't use it:

```typescript
export type RootTabParamList = {
  Habits: undefined;
  Practice: undefined;
  Course: undefined;
  Journal: undefined;
  Map: undefined;
};
```

All routes currently accept `undefined` params, but after Phase 3, Practice and Course need to accept an optional `stageNumber` parameter. MapScreen uses `as never` to bypass the type system:

```tsx
navigation.navigate('Practice' as never);
```

There's also no deep linking configuration, so the app can't handle URLs like `adepthood://habit/5`.

## Scope

Make all navigation fully type-safe and add route parameters where needed.

## Tasks

1. **Update `RootTabParamList` with proper params**
   ```typescript
   export type RootTabParamList = {
     Habits: undefined;
     Practice: { stageNumber?: number } | undefined;
     Course: { stageNumber?: number } | undefined;
     Journal: undefined;
     Map: undefined;
   };
   ```

2. **Create typed navigation hooks**
   - `useAppNavigation()` — typed wrapper around `useNavigation<BottomTabNavigationProp<RootTabParamList>>()`
   - `useAppRoute<T extends keyof RootTabParamList>()` — typed wrapper around `useRoute()`
   - Export from a shared `navigation/hooks.ts` file

3. **Update all `navigation.navigate()` calls**
   - MapScreen: `navigation.navigate('Practice', { stageNumber: activeStage.stageNumber })`
   - Any other cross-tab navigation

4. **Update screen components to read params**
   - PracticeScreen: `const { stageNumber } = useAppRoute<'Practice'>().params ?? {}`
   - CourseScreen: same pattern

5. **Optional: Add deep linking config**
   - In `App.tsx`, configure `linking` prop on `NavigationContainer`
   - Define URL patterns: `adepthood://habits`, `adepthood://practice/:stageNumber`
   - This enables link sharing and push notification deep links

## Acceptance Criteria

- Zero `as never` or `as any` casts in navigation code
- Route parameters are type-checked at compile time
- Practice and Course screens can receive a stage number from the Map
- TypeScript catches invalid route names at compile time

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/navigation/BottomTabs.tsx` | Modify (update param types) |
| `frontend/src/navigation/hooks.ts` | **Create** (typed nav hooks) |
| `frontend/src/features/Map/MapScreen.tsx` | Modify (use typed nav) |
| `frontend/src/features/Practice/PracticeScreen.tsx` | Modify (read params) |
| `frontend/src/features/Course/CourseScreen.tsx` | Modify (read params) |
| `frontend/src/App.tsx` | Modify (optional: deep linking) |
