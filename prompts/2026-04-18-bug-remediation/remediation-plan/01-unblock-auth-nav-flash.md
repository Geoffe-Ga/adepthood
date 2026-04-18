# Prompt 01 — Unblock the auth/nav flash (Stage 1, serial)

## Role
You are a senior React Native + FastAPI engineer pairing on an urgent production regression. You specialize in auth lifecycles, React Navigation state, and HTTP client resilience. You care more about user experience than clever code.

## Goal
Stop the app from booting signed-in users back to the Signup screen. Land a coordinated diff across `AuthContext`, the root navigator, the API client, and the Zustand stores so that:

- A transient 401 **never** unmounts `BottomTabs`.
- `isLoading` **never** flips back to `true` mid-session.
- Token bootstrap completes synchronously (from the RN perspective) before the navigator decides which tree to mount.
- On explicit logout, every Zustand store is reset so the next user does not see residue.

Success criteria (all must hold):

1. Repro script (clear AsyncStorage → signup → tap BotMason tab) lands on BotMason, not Signup, across three repeated runs on iOS + web.
2. Injecting a synthetic 401 on any authenticated endpoint shows a re-auth sheet **without** unmounting `RootStack`.
3. `logout()` clears token AND every Zustand store AND any AsyncStorage keys owned by feature stores.
4. Existing tests stay green; new tests cover the four bugs below.

## Context
- Symptom inventory and root causes live in:
  - `prompts/2026-04-18-bug-remediation/03-frontend-navigation.md` — BUG-NAV-001, 002, 005, 007, 010, 011, 012
  - `prompts/2026-04-18-bug-remediation/02-frontend-auth-context.md` — BUG-FE-AUTH-001, 002, 004, 005, 010
  - `prompts/2026-04-18-bug-remediation/04-frontend-api-client.md` — any BUG-FE-API-* tagged "401 triggers global logout" (read the TOC only; pick the 2-3 most relevant)
  - `prompts/2026-04-18-bug-remediation/18-frontend-design-state-tests.md` — BUG-FE-STATE-001
- Files you will touch (expect ≤12): `frontend/src/App.tsx`, `frontend/src/navigation/{RootStack,BottomTabs,hooks}.ts(x)`, `frontend/src/context/AuthContext.tsx`, `frontend/src/api/client.ts` (or equivalent), `frontend/src/store/use*Store.ts`, `frontend/src/storage/authStorage.ts`.
- Core design decision (already endorsed in the report): replace `token ? Tabs : Auth` with an explicit `authStatus: 'loading' | 'authenticated' | 'reauth-required' | 'anonymous'`. 401 → `'reauth-required'` (modal overlay, tabs stay mounted); explicit logout / bootstrap-with-no-token → `'anonymous'`.

## Output Format
Deliver the work as **3 atomic commits on the current feature branch**, in this order:

1. `refactor(frontend): introduce authStatus state machine in AuthContext` — no navigator changes yet; add the state, wire bootstrap, keep legacy `token` field working so nothing breaks.
2. `fix(frontend): gate RootNavigator on authStatus, add re-auth overlay` — swap the conditional, mount the overlay, stop unmounting Tabs on 401.
3. `fix(frontend): reset all stores on logout + harden 401 path` — store-reset registry, 401 → reauth-required (not logout), tests for all four bugs.

Each commit message body must list the BUG-IDs it closes.

## Examples

Store-reset registry pattern:
```ts
// frontend/src/store/registry.ts
const resetters = new Set<() => void>();
export function registerStoreReset(fn: () => void) { resetters.add(fn); }
export function resetAllStores() { resetters.forEach(r => r()); }

// frontend/src/store/useHabitStore.ts
export const useHabitStore = create<HabitState>((set) => ({ ... }));
registerStoreReset(() => useHabitStore.setState(initialHabitState, true));
```

Navigator gate:
```tsx
function RootNavigator() {
  const { authStatus } = useAuth();
  if (authStatus === 'loading') return <BootSplash />;     // cold-start only
  if (authStatus === 'anonymous') return <AuthNavigator />;
  return (
    <>
      <RootStack />
      {authStatus === 'reauth-required' && <ReauthSheet />}
    </>
  );
}
```

## Requirements
- **Do not** read every bug report end-to-end. Read TOC + the specific bug blocks for the IDs listed above. Use `Grep` for file:line targeting.
- **Do not** attempt to fix other 401 quirks, refresh-token redesigns, or auth screen polish (BUG-FE-AUTH-011+ are out of scope — covered by later prompts).
- Follow `stay-green`: write the failing test first for each bug, watch it fail, then fix.
- Follow `max-quality-no-shortcuts`: no `// @ts-ignore`, no `any`.
- Run `pre-commit run --all-files` before every commit; iterate until clean.
- Preserve navigation state: verify manually that tapping a tab after a forced 401 returns to the same screen (add an E2E-style integration test under `frontend/src/__tests__/navigation/` if one does not exist).
- If you discover a bug outside this scope that blocks the fix, stop and append a note to the report's "Remediation notes" section rather than fixing it here.
- Work on a fresh branch off `main` named `claude/bug-fix-01-unblock-auth-nav-flash` (or whatever the opening session message specifies). Push only when all three commits land.
