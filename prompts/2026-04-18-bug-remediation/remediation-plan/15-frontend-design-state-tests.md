# Prompt 15 — Frontend design system, state, storage, tests (Wave 4, parallelizable)

## Role
You are a design-system and infra engineer on the frontend side. You own tokens, shared primitives, Zustand selector ergonomics, storage edge cases, and the Jest/Babel config. You want the app to meet WCAG AA, to never leak data across users, and to have a test config that does not pretend DOM components can run in a `node` environment.

## Goal
Fix the remaining High + Critical bugs in report 18 that are NOT covered by Prompts 01 (store reset), 08 (optimistic storage race), or 10 (ErrorBoundary Sentry wiring).

Success criteria:

1. Design tokens: `colors.neutral` + any failing-AA text colors are replaced with WCAG-AA-compliant values; a minimum `touchTarget: 44` token is added and enforced at shared primitives.
2. Dark-mode palette shipped (or a documented plan deferred with ticket reference — not silently skipped).
3. `llmKeyStorage.ts` gets a web fallback with the same contract as `authStorage.ts` (prevent BYOK crash on Expo Web — BUG-FE-STORAGE-001).
4. Zustand factory selectors stop returning a fresh function per call — either memoized per-id or migrated to `useShallow` / `createSelector`.
5. `updateStageProgress` rejects unknown keys (schema drift surfacing).
6. Empty / whitespace credentials rejected at the `saveToken` / `saveLlmApiKey` boundary.
7. Jest config: `clearMocks: true`, `resetMocks: true`; switch `testEnvironment` to `jsdom` for components; `reanimated/plugin` included only under `env.production`.
8. Toast queue race fixed; DatePicker min/max enforced on quick-select.

## Context
Bug IDs:
- `prompts/2026-04-18-bug-remediation/18-frontend-design-state-tests.md`:
  - **BUG-FE-STORAGE-001** (Critical; BYOK crash on Expo Web).
  - High: -UI-001/-002/-003 (design tokens), -UI-105 (toast queue race), -UI-107 (DatePicker min/max), -STATE-002 (factory selectors), -TEST-001 (`clearMocks`/`resetMocks`).
  - Medium: -UI-004/-005, -UI-103/-104/-106/-108, -STATE-003, -STORAGE-003/-004, -TEST-002.
  - Low: -UI-109, -TEST-003.
  - Skip BUG-FE-STATE-001 [done-by-01], -UI-101/-102 [done-by-10], -STORAGE-002 [done-by-08].

Files (expect ≤18): `frontend/src/design/tokens.ts`, `frontend/src/design/DesignSystem.ts`, `frontend/src/design/useResponsive.ts`, `frontend/src/components/{Toast,ToastProvider,DatePicker,OfflineBanner}.tsx`, `frontend/src/store/useHabitStore.ts` (selectors only — do not re-touch logout reset), `frontend/src/store/useStageStore.ts`, `frontend/src/storage/llmKeyStorage.ts`, `frontend/src/storage/authStorage.ts`, `frontend/jest.config.js`, `frontend/babel.config.js`.

## Output Format
Four atomic commits:

1. `fix(frontend-design): WCAG-AA colors, touchTarget token, dark-mode palette (BUG-FE-UI-001/-002/-003, Medium)`.
2. `fix(frontend-components): Toast queue race, DatePicker min/max, a11y polish (BUG-FE-UI-105/-107, Medium/Low)`.
3. `fix(frontend-state+storage): selector memoization; stage update reject-unknown; web BYOK fallback; trim credentials (BUG-FE-STATE-002/-003, BUG-FE-STORAGE-001/-003/-004)`.
4. `chore(frontend-test): clearMocks/resetMocks; jsdom env; reanimated prod-only (BUG-FE-TEST-001/-002/-003)`.

## Examples

Token with minimum touch target:
```ts
// frontend/src/design/tokens.ts
export const tokens = {
  colors: {
    neutral: '#6e6e6e', // was #8c8c8c (AA-failing on #f8f8f8); new ratio ~4.9:1
    background: { primary: '#f8f8f8', ... },
    ...
  },
  touchTarget: { minimum: 44 },
};
```

Selector memoization:
```ts
// BEFORE (factory returns a new fn per call; Zustand re-subscribes every render):
export const selectHabitById = (id: string) => (s: HabitState) => s.habits[id];

// AFTER (per-id memo via closure):
const selectorCache = new Map<string, (s: HabitState) => Habit | undefined>();
export const selectHabitById = (id: string) => {
  let sel = selectorCache.get(id);
  if (!sel) { sel = (s) => s.habits[id]; selectorCache.set(id, sel); }
  return sel;
};
```

Web BYOK fallback:
```ts
// frontend/src/storage/llmKeyStorage.ts
const webSupported = typeof window !== 'undefined' && 'localStorage' in window;
export async function saveLlmApiKey(key: string) {
  const trimmed = key.trim();
  if (!trimmed) throw new Error('empty key');
  if (Platform.OS === 'web') {
    if (!webSupported) throw new Error('no web storage');
    localStorage.setItem('llm_api_key', trimmed);
    return;
  }
  await SecureStore.setItemAsync('llm_api_key', trimmed);
}
```

Jest config:
```js
module.exports = {
  preset: 'jest-expo',
  testEnvironment: 'jsdom',
  clearMocks: true,
  resetMocks: true,
  setupFiles: [...],
};
```

## Requirements
- `frontend-aesthetics` skill for token decisions — avoid arbitrary hex choices, anchor in the existing palette where feasible.
- `testing` skill for Jest config changes — run the existing suite after each change to ensure nothing regresses.
- `max-quality-no-shortcuts`: don't add `// @ts-expect-error` to Jest config edits.
- Run the full frontend test suite (`npm test`) AND `npx tsc --noEmit` after each commit — Jest config changes have surprising reach.
- Do NOT touch `useHabitStore`'s reset logic (owned by Prompt 01).
- Parallelizable with 11-14.
- `pre-commit run --all-files` before each commit.
