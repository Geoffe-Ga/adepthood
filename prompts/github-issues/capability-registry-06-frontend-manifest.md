# capability-registry-06: Frontend feature manifest → registry-driven nav/store/flags

**Labels:** `enhancement`, `architecture`, `frontend`, `capability-registry`
**Epic:** [The Capability Registry](capability-registry-epic.md)
**Depends on:** 01, 02
**Estimated LoC:** ~300

## Role

You are a React Native engineer collapsing the frontend's per-feature hand-wiring
into one declarative manifest. Today a tab is spread across `RING_TABS`,
`RING_FLAG_BY_ROUTE`, `RingKey`, `RootTabParamList`, the deep-link config, and
four spots in the depth-preferences store
(`frontend/src/navigation/BottomTabs.tsx:100-152`, `App.tsx` linking,
`frontend/src/store/useDepthPreferencesStore.ts:35-116`).

## Goal

Define a `FeatureManifest` and derive the bottom-tab list, opt-in gating,
deep-link entries, and store-reset from an array of manifests instead of
hard-coded literals. Convert the existing Habits and Practice features to
manifests as the proof; behaviour (tab order, ring gating, redirect-on-disable)
is unchanged.

## Context

The frontend already has the two ingredients: a config-driven tab assembler
(`RING_TABS` filtered by depth flags) and a self-registration reset registry
(`frontend/src/store/registry.ts`). This issue joins them: a manifest is the
single source a feature contributes, and nav/flags/links/reset all read it.

## Tasks

1. **`frontend/src/features/manifest.ts`:** define
   ```ts
   interface FeatureManifest {
     key: string;              // matches backend capability feature_flag
     routeName: keyof RootTabParamList;
     title: string;
     icon: LucideIcon;
     screen: React.ComponentType<object>;
     slot: 'leading' | 'ring' | 'trailing';
     deepLinkPath?: string;    // e.g. 'habits'
   }
   export const FEATURES: readonly FeatureManifest[];
   ```
   Populate with the current six tabs (Journal/Today leading, Habits/Practice/Course ring, Map trailing).
2. **Refactor `BottomTabs.tsx`** to build `LEADING/RING/TRAILING` from `FEATURES`
   by `slot`, gate ring tabs via the generic `isEnabled(key)` selector (02), and
   drive the focus-redirect from the manifest instead of `RING_FLAG_BY_ROUTE`.
   `RootTabParamList` stays the type source; assert manifest `routeName`s are keys of it.
3. **Refactor deep-linking** in `App.tsx` to generate the `screens` map from
   manifests carrying `deepLinkPath`.
4. **Store-reset:** keep per-store `registerStoreReset` (unchanged), but document
   that a feature's store lives in its folder and self-registers on import — the
   manifest references the screen, which imports the store.
5. **Tests:** tab order + ring gating unchanged (extend
   `navigation/__tests__/BottomTabs.test.tsx`); a manifest with `isEnabled=false`
   hides its tab and redirects focus; a new manifest entry renders a tab with no
   other file edits.

## Acceptance Criteria

- [ ] Current tab order, icons, ring gating, and redirect-on-disable are byte-for-byte unchanged (tests prove it).
- [ ] Adding a tab is a single `FEATURES` entry (+ its feature folder) — no edits to `RING_TABS`, `RingKey`, `RING_FLAG_BY_ROUTE`, or the linking map.
- [ ] Ring gating reads the generic `isEnabled(key)` selector from 02.
- [ ] `cd frontend && npm test && npm run lint && npx tsc --noEmit` green.

## Files

| File | Action |
|------|--------|
| `frontend/src/features/manifest.ts` | **Create** |
| `frontend/src/navigation/BottomTabs.tsx` | Modify |
| `frontend/src/App.tsx` | Modify (generate linking) |
| `frontend/src/navigation/__tests__/BottomTabs.test.tsx` | Modify |
| `frontend/src/features/__tests__/manifest.test.ts` | **Create** |

## Constraints

- Keep `RootTabParamList` as the typed route source; the manifest must be
  type-checked against it (no `any`, no route-name drift).
- No behaviour change in this issue — it is a pure refactor to the manifest shape.
- Preserve the `FeatureErrorBoundary` wrapping per tab.
