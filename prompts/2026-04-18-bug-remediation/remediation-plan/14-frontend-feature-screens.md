# Prompt 14 — Frontend feature screens (Wave 4, split into two parallel sub-prompts)

## Role
You are a React Native engineer fixing feature screens: Habits, Journal, Practice, Course, Map. You think in terms of component state lifecycles, React Navigation focus events, and AsyncStorage sync.

## Goal
Fix the High-severity bugs in reports 16 and 17 that remain after Prompts 01, 03, 05, 08, 09. Split into **Prompt 14A (Habits + Journal)** and **Prompt 14B (Practice + Course + Map)** to avoid Stream Idle timeouts.

Success criteria: every non-themed High-severity bug listed in the sub-scopes is closed; coverage stays green; manual smoke on iOS + web for each modified screen.

## Context — split the work

### Prompt 14A — Habits + Journal screens
Bug IDs from `prompts/2026-04-18-bug-remediation/16-frontend-features-habits-journal.md`:
- BUG-FE-HABIT-005 (duplicate notification schedules), -008 (`useModalCoordinator.open` resets all flags), -101 (re-triggerable after completion), -103 (step advance races in-flight request), -105 (no dedupe/length validation + ID collision), -201 (`parseEnergyValue` NaN → 0), -202 (reset start-date wipes completions silently), -204 (drag order clobbered on parent re-render).
- BUG-FE-JOURNAL-001 (no AbortController on stream), -101 (unbounded message length), -102 (double-submit on rapid taps), -105 (stale debounce + prop desync).
- Pick Medium items as you pass them (-003/-004/-006/-007, -102/-104/-106, -203, -004/-005/-006/-007/-008, -103/-104/-106/-107).
- Skip themed items: -001/-205 [done-by-08], -002/-206/-207 [done-by-05], -002/-003 [done-by-08].

Files (expect ≤14): `frontend/src/features/Habits/**`, `frontend/src/features/Journal/**`, tests.

### Prompt 14B — Practice + Course + Map screens
Bug IDs from `prompts/2026-04-18-bug-remediation/17-frontend-features-practice-course-map.md`:
- BUG-FE-PRACTICE-102 (rapid Start/Cancel race → concurrent intervals), -103 (Sound leak on unmount), -104 (pause keeps counting via re-subscribe), -106 (Medium).
- Pick Medium/Low items (-003/-005/-006/-007/-106/-107/-108/-109) as you pass them.
- BUG-FE-COURSE items: all the non-gated ones (-003/-004/-005/-006 + any remaining Highs after Prompt 03).
- BUG-FE-MAP items: -003/-004/-006/-007 (Medium/Low). -005 [done-by-08 via useOptimisticMutation].
- Skip themed items: -001/-002/-101/-105/-004 [done-by-03/09], -001/-002 course [done-by-03], -001/-002/-005 map [done-by-03/08].

Files (expect ≤14): `frontend/src/features/Practice/**`, `frontend/src/features/Course/**`, `frontend/src/features/Map/**`, tests.

## Output Format

**Prompt 14A commits (4-5):**
1. `fix(frontend-habits): modal coordinator, duplicate notifications, step-advance races (BUG-FE-HABIT-005/-008/-101/-103/-105)`.
2. `fix(frontend-habits): energy parse NaN; reset start-date guard; drag-order stability (BUG-FE-HABIT-201/-202/-204)`.
3. `fix(frontend-journal): AbortController on stream; length cap; double-submit guard; debounce desync (BUG-FE-JOURNAL-001/-101/-102/-105)`.
4. Medium pickups (optional — 1 commit).

**Prompt 14B commits (4-5):**
1. `fix(frontend-practice): race-safe start/cancel; Sound cleanup; pause semantics (BUG-FE-PRACTICE-102/-103/-104)`.
2. `fix(frontend-course): locked-content display polish + Medium pickups`.
3. `fix(frontend-map): Medium/Low pickups (hotspot a11y, reduced-motion, etc.)`.
4. Test-harness cleanups surfaced by the above.

## Examples

Modal coordinator bug fix:
```ts
// BEFORE: open('habitComplete') resets ALL flags first.
open: (key) => set(() => ({ modals: { [key]: true } }))
// AFTER: preserve other flags.
open: (key) => set((s) => ({ modals: { ...s.modals, [key]: true } }))
```

Race-safe timer:
```tsx
const taskIdRef = useRef(0);
const start = () => {
  const myTask = ++taskIdRef.current;
  interval.current = setInterval(() => {
    if (taskIdRef.current !== myTask) return; // superseded
    tick();
  }, 1000);
};
const cancel = () => {
  taskIdRef.current++;
  clearInterval(interval.current);
};
```

Journal double-submit guard:
```tsx
const inFlight = useRef(false);
const send = async (text: string) => {
  if (inFlight.current) return;
  inFlight.current = true;
  try { await api.journal.send(text); } finally { inFlight.current = false; }
};
```

## Requirements
- `frontend-aesthetics`: respect design tokens; tap targets >=44pt; readable contrast.
- `testing`: use `@testing-library/react-native`; mock timers where appropriate.
- `max-quality-no-shortcuts`: no `any`, no `@ts-ignore`.
- Manual QA: smoke on iOS simulator + Expo web; screenshot attached in PR description.
- Do NOT reintroduce inline date math — use `frontend/src/utils/dateUtils.ts` from Prompt 05.
- Do NOT reintroduce ad-hoc optimistic updates — use `useOptimisticMutation` from Prompt 08.
- Parallelizable with 11, 12, 13, 15.
- `pre-commit run --all-files` before each commit.
