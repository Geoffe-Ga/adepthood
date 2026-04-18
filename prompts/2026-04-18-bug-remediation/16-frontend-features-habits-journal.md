# Frontend — Habits & Journal Feature Bug Report — 2026-04-18

**Scope:** `frontend/src/features/Habits/**` (core screens 1.4k LOC, 6 modals ~3k LOC, services 500 LOC, utils 480 LOC) and `frontend/src/features/Journal/**` (JournalScreen 981 LOC, 5 aux components ~500 LOC). Covers habit tile toggle / streak / notification flow, the 4-step onboarding modal, goal/settings/stats/reorder modals, plus the journal chat/stream/search/tag-filter/weekly-prompt-banner UI.

**Total bugs: 36 — 2 Critical / 17 High / 17 Medium / 0 Low**

## Executive Summary

1. **Date/timezone drift across every streak-relevant surface (Critical/High).** BUG-FE-HABIT-002, -006, -206, -207: completion dates, unlock countdowns, start dates, and streak computation each mix UTC arithmetic with local display. A user in a negative-offset timezone logs at 9 PM and sees the completion land on tomorrow's row; a user whose last completion was "yesterday" still sees the pre-miss streak because the function never compares to today.
2. **Optimistic writes that don't roll back (Critical/High).** BUG-FE-HABIT-001, -205: `logUnit` applies the optimistic increment to the Zustand store and `AsyncStorage` before capturing a rollback closure, and the pending-retry queue drops `timestamp` so replays post at the wrong day. BUG-FE-JOURNAL-002 does the same for bot sends — a failed stream leaves a ghost user message that never reaches the server.
3. **Stream lifecycle leaks (High).** BUG-FE-JOURNAL-001, -003: the chat screen has no `AbortController`, so streams keep running after the user navigates away (and keep counting against the wallet per backend BUG-BM-006). `Date.now()` ids collide across rapid sends, appending chunks to the wrong bubble.
4. **Modal/onboarding state races (High/Medium).** BUG-FE-HABIT-008 (`useModalCoordinator.open` resets every flag, closing the modal you're trying to layer over), BUG-FE-HABIT-101 (onboarding re-triggers with stale data after completion), BUG-FE-HABIT-103 (step advance while templates request is in flight routes the successful flow into the error catch branch), BUG-FE-HABIT-204 (reorder drag state clobbered on every parent re-render).
5. **Destructive UX without confirmation (High).** BUG-FE-HABIT-202: the "Reset start date" path wipes all completions with no confirm dialog — a one-tap data-loss UX. Mirrors BUG-FE-HABIT-205 (lost check-ins on failed replay).
6. **Validation + a11y gaps (Medium).** BUG-FE-HABIT-201 (`parseEnergyValue` coerces garbage to 0), BUG-FE-HABIT-203 (division-by-zero in stats), BUG-FE-HABIT-004/007 (FlatList perf + missing a11y roles), BUG-FE-JOURNAL-101/102 (unbounded message length + double-submit), BUG-FE-JOURNAL-103/104 (streaming cursor in copyable text, no SR role/timestamp), BUG-FE-JOURNAL-005 (fresh-object deps defeat `useCallback`), BUG-FE-JOURNAL-007 (lying `getItemLayout` on inverted variable-height list breaks pagination), BUG-FE-JOURNAL-006 (no draft persistence — half-typed reflections lost on nav-away).

## Table of Contents

| # | ID | Severity | Component | Title |
|---|----|----------|-----------|-------|
| 1 | BUG-FE-HABIT-001 | Critical | `Habits/services/habitManager.ts` | Optimistic logUnit rollback gap |
| 2 | BUG-FE-HABIT-002 | High | `Habits/HabitUtils.ts` | UTC/local streak drift |
| 3 | BUG-FE-HABIT-003 | Medium | `Habits/hooks/useHabits.ts` | useHabitStats stale-closure + silent fallback |
| 4 | BUG-FE-HABIT-004 | Medium | `Habits/HabitsScreen.tsx` | FlatList re-render storm |
| 5 | BUG-FE-HABIT-005 | High | `Habits/hooks/useHabitNotifications.ts` | Duplicate notification schedules |
| 6 | BUG-FE-HABIT-006 | Medium | `Habits/HabitUtils.ts` | calculateDaysUntilUnlock UTC/local mix |
| 7 | BUG-FE-HABIT-007 | Medium | `Habits/HabitTile.tsx` | Locked-tile a11y gaps + <44pt targets |
| 8 | BUG-FE-HABIT-008 | High | `Habits/hooks/useModalCoordinator.ts` | `open()` resets all modal flags |
| 9 | BUG-FE-HABIT-101 | High | `Habits/components/OnboardingModal.tsx` | Re-triggerable after completion |
| 10 | BUG-FE-HABIT-102 | Medium | `Habits/components/OnboardingModal.tsx` | Count-warning double-modal |
| 11 | BUG-FE-HABIT-103 | High | `Habits/components/OnboardingModal.tsx` | Step advance races in-flight request |
| 12 | BUG-FE-HABIT-104 | Medium | `Habits/components/OnboardingModal.tsx` | Reveal effect stale-closure deps |
| 13 | BUG-FE-HABIT-105 | High | `Habits/components/OnboardingModal.tsx` | No dedupe/length validation + ID collision |
| 14 | BUG-FE-HABIT-106 | Medium | `Habits/components/OnboardingModal.tsx` | No focus management / SR announcement |
| 15 | BUG-FE-HABIT-201 | High | `Habits/components/HabitSettingsModal.tsx` | `parseEnergyValue` NaN → 0 |
| 16 | BUG-FE-HABIT-202 | High | `Habits/components/MissedDaysModal.tsx` | Reset start-date wipes completions silently |
| 17 | BUG-FE-HABIT-203 | Medium | `Habits/components/StatsModal.tsx` | Division-by-zero, no empty state |
| 18 | BUG-FE-HABIT-204 | High | `Habits/components/ReorderHabitsModal.tsx` | Drag order clobbered on parent re-render |
| 19 | BUG-FE-HABIT-205 | Critical | `Habits/services/habitManager.ts` | logUnit replay drops `timestamp` |
| 20 | BUG-FE-HABIT-206 | High | `Habits/HabitUtils.ts` | calculateHabitStartDate UTC drift |
| 21 | BUG-FE-HABIT-207 | High | `Habits/HabitUtils.ts` | computeCurrentStreak never compares to today |
| 22 | BUG-FE-JOURNAL-001 | High | `Journal/JournalScreen.tsx` | No AbortController on stream |
| 23 | BUG-FE-JOURNAL-002 | High | `Journal/JournalScreen.tsx` | Orphaned optimistic user message on stream error |
| 24 | BUG-FE-JOURNAL-003 | High | `Journal/JournalScreen.tsx` | `Date.now()` id collision on retry |
| 25 | BUG-FE-JOURNAL-004 | Medium | `Journal/JournalScreen.tsx` | Search refetch per keystroke |
| 26 | BUG-FE-JOURNAL-005 | Medium | `Journal/JournalScreen.tsx` | `useBotSend` deps object literal defeats memo |
| 27 | BUG-FE-JOURNAL-006 | Medium | `Journal/JournalScreen.tsx` | No draft persistence on nav-away |
| 28 | BUG-FE-JOURNAL-007 | Medium | `Journal/JournalScreen.tsx` | `getItemLayout` lies about variable heights |
| 29 | BUG-FE-JOURNAL-008 | Medium | `Journal/JournalScreen.tsx` | `loadMessages` swallows errors |
| 30 | BUG-FE-JOURNAL-101 | High | `Journal/ChatInput.tsx` | Unbounded message length |
| 31 | BUG-FE-JOURNAL-102 | High | `Journal/ChatInput.tsx` | Double-submit on rapid taps |
| 32 | BUG-FE-JOURNAL-103 | Medium | `Journal/MessageBubble.tsx` | Streaming cursor pollutes copy/selection |
| 33 | BUG-FE-JOURNAL-104 | Medium | `Journal/MessageBubble.tsx` | Missing SR role/timestamp |
| 34 | BUG-FE-JOURNAL-105 | High | `Journal/SearchBar.tsx` | Stale debounce + prop desync |
| 35 | BUG-FE-JOURNAL-106 | Medium | `Journal/TagFilter.tsx` | `All` noop + duplicate keys |
| 36 | BUG-FE-JOURNAL-107 | Medium | `Journal/WeeklyPromptBanner.tsx` | Stale after submit, no dismiss |

---

## Habits — core screens & hooks

### BUG-FE-HABIT-001 — Optimistic logUnit writes to store before capturing rollback, and swallows revert by invoking returned function too late
- **Severity:** Critical
- **Component:** `frontend/src/features/Habits/services/habitManager.ts:423-453`
- **Symptom:** When the goal-completion POST fails, the user's check-in appears to succeed (tile keeps new streak/progress), and the queued pending check-in plus any toast-induced streak bump stay visible. The call to `revertOnFailure(prev, ...)(err)` does reset `habits` to `prev`, but by that point the milestone toast has already fired, `persistHabits(next)` has already flushed the unrolled-back state to AsyncStorage, and the pending check-in has already been saved — leaving the store and disk in inconsistent states.
- **Root cause:**
  ```tsx
  setHabits(next);
  void persistHabits(next);        // disk write is not reverted on failure
  ...
  goalCompletionsApi.create(pendingPayload).catch((err: unknown) => {
    void savePendingCheckIn({...});
    revertOnFailure(prev, "...")(err);   // reverts memory but AsyncStorage
  });                                    // still holds the optimistic next
  ```
  The optimistic write is persisted immediately, but `revertOnFailure` only calls `setHabits(prev)` — it never calls `persistHabits(prev)`. After the next cold start, `loadCachedHabits()` rehydrates the non-rolled-back state and desyncs from server. Also, `prev` is captured before `logAndToast` runs, but the milestone toast has already fired, so users see "Stretch Goal achieved!" for a check-in that the server rejected.
- **Fix:** Defer toast + `persistHabits` until the API promise resolves successfully. On failure, rollback both memory and disk: `setHabits(prev); void persistHabits(prev);`. Move `buildMilestoneToast` invocation into the `.then(...)` of the API call.

### BUG-FE-HABIT-002 — Streak and last_completion_date computed in UTC while user lives in local time, causing off-by-one-day streak drift
- **Severity:** High
- **Component:** `frontend/src/features/Habits/HabitUtils.ts:454-471` (`logHabitUnits`) and `HabitUtils.ts:313-314` (`utcDayKey`)
- **Symptom:** A user in e.g. UTC-08:00 who logs a habit at 7pm local on Monday sees `last_completion_date` stored as Tuesday 03:00 UTC. When they log again at 7pm Tuesday local (Wednesday 03:00 UTC), `utcDayKey(new Date(last_completion_date)) === utcDayKey(date)` compares `2026-04-15` vs `2026-04-16`, so `alreadyLoggedToday` is false and the streak increments. The reverse: at 11:30pm local (07:30 UTC next day) the first log of a brand-new day is detected as "already today" because UTC day hasn't rolled over yet. Streaks drift up or down silently depending on time zone and time of day.
- **Root cause:**
  ```tsx
  const utcDayKey = (d: Date): string => d.toISOString().slice(0, 10);
  ...
  const alreadyLoggedToday =
    habit.last_completion_date &&
    utcDayKey(new Date(habit.last_completion_date)) === utcDayKey(date);
  ```
  UTC day boundaries do not correspond to the user's "calendar day." A user who logs a habit every evening at 9pm PST (05:00 UTC next day) will have all their completions bucketed to the wrong UTC day, breaking streaks, `calculateMissedDays`, `generateStatsForHabit` day-of-week buckets (`getUTCDay()` vs local), and the unique-completion-day math.
- **Fix:** Introduce a single `localDayKey(d)` helper that uses `d.getFullYear()/getMonth()/getDate()` (zero-padded) and replace all `utcDayKey` call sites. Cross-refs backend BUG-STREAK-*: the server must agree on the client's `tz_offset_minutes` — include it in the check-in payload.

### BUG-FE-HABIT-003 — useHabitStats effect has stale-closure on `visible` and missing error handling leaks into fallback silently
- **Severity:** High
- **Component:** `frontend/src/features/Habits/HabitsScreen.tsx:372-396`
- **Symptom:** When a user opens the Stats modal, tabs to another habit quickly, and the first fetch resolves after the second, the stale first response overwrites the correct habit's stats. There is no AbortController and no check that the habit passed to `fetchStats` matches the current `habit` prop at resolve time. Additionally, any API failure silently falls through to `generateStatsForHabit(h)` without surfacing an error — so users see stale/fake stats instead of a "couldn't load stats" state.
- **Root cause:**
  ```tsx
  const fetchStats = useCallback((h: Habit) => {
    if (h.id == null) return;
    habitsApi.getStats(h.id, token ?? undefined)
      .then((apiStats) => setStats(toLocalHabitStats(apiStats)))
      .catch(() => setStats(generateStatsForHabit(h)));  // silent fallback
  }, [token]);
  useEffect(() => { if (visible && habit) fetchStats(habit); else setStats(null); },
    [visible, habit, fetchStats]);
  ```
  No cleanup function means an in-flight request will still call `setStats` on an unmounted or re-targeted modal. `habit` is an object prop — a re-render with a reference-equal object won't retrigger fetch, but a fresh object from the store will trigger re-fetch on every log/update while the modal is open, hammering the API.
- **Fix:** Track a `requestId = useRef(0)` or use an `AbortController`; bail on resolve if `requestId.current !== myId`. Depend on `habit?.id` rather than `habit`. Surface fetch errors as a user-visible state distinct from the computed fallback.

### BUG-FE-HABIT-004 — FlatList keyExtractor and non-memoized renderItem cause excessive re-renders of habit tiles
- **Severity:** Medium
- **Component:** `frontend/src/features/Habits/HabitsScreen.tsx:287-301, 329-370`
- **Symptom:** On every parent state change (modal open/close, mode switch, even toast), every HabitTile re-renders because `renderHabitTile` is a new function each render (constructed inside `useHabitTileRenderer` but returned without `useCallback`). Also `keyExtractor` falls back to `item.name` when `item.id` is nullish — during onboarding, two freshly-built habits can share the same name ("New Habit"), which React treats as duplicate keys and warns about. There's no `getItemLayout`, no `removeClippedSubviews`, no `windowSize` tuning, and no `React.memo` on `HabitTile`.
- **Root cause:**
  ```tsx
  const useHabitTileRenderer = (...) => {
    const renderHabitTile = ({ item, index }) => { ... };   // new fn per render
    return renderHabitTile;                                 // not memoized
  };
  <FlatList keyExtractor={(item) => item.id?.toString() ?? item.name} ... />
  ```
  Every re-render of `HabitsScreen` rebuilds `renderHabitTile`, which breaks FlatList's renderItem identity check and re-renders all 10 tiles. Each tile runs `useHabitTileData` and `useColorTransition` — non-trivial work.
- **Fix:** Wrap `renderHabitTile` in `useCallback` with a stable deps list; `export default React.memo(HabitTile)` with a custom comparator that checks `habit.id`, `streak`, `completions.length`, `revealed`. Generate a stable fallback key (e.g. `onboarding-${index}`) when `id` is missing. Add `getItemLayout` once tile height is deterministic.

### BUG-FE-HABIT-005 — updateHabitNotifications does not cancel by id when notificationIds array is stale, leaking duplicate schedules
- **Severity:** High
- **Component:** `frontend/src/features/Habits/hooks/useHabitNotifications.ts:115-147`
- **Symptom:** If a user edits a habit twice rapidly (change time, then change time again before the first schedule completes), `habit.notificationIds` may still reflect state from before the first edit. The first update cancels those old ids and schedules N new ones but the store may not yet have the fresh ids when the second update runs. The second update reads `habit.notificationIds` (possibly still the pre-first-edit ids), cancels them (already cancelled, no-op), and schedules another N — doubling the live schedules on the device. Similarly, `deleteHabit` calls `cancelForHabit(habitId)` which only reads the AsyncStorage record — but `updateHabit` stores new ids returned by `updateHabitNotifications` into... nowhere: the function's return value is thrown away (`void updateHabitNotifications(updatedHabit)`), so `habit.notificationIds` never gets updated in the store, and the next edit will always use stale ids.
- **Root cause:**
  ```tsx
  updateHabit: (updatedHabit: Habit): void => {
    ...
    void updateHabitNotifications(updatedHabit);  // returned ids discarded
    void persistHabits(next);
  ```
  Even though `updateHabitNotifications` returns `string[]`, the service drops them and the habit object never gets a refreshed `notificationIds`. On the next edit, the scheduling code falls back to `persistedIds` from AsyncStorage, which is correct for single-device usage but becomes inconsistent during rapid edits because there's no in-flight-mutex.
- **Fix:** Await `updateHabitNotifications`, assign the returned ids onto the habit, and update the store+persist with those ids. Guard concurrent edits with a per-habit-id promise map so the second edit waits for the first to complete.

### BUG-FE-HABIT-006 — calculateDaysUntilUnlock mixes local and UTC dates, displaying wrong countdown near midnight
- **Severity:** Medium
- **Component:** `frontend/src/features/Habits/HabitTile.tsx:507-519`
- **Symptom:** For a habit whose `start_date` was set via `calculateHabitStartDate` (which uses `setUTCDate`), the unlock label can show "Unlocks in 0 days" for an entire local day if the user's local zone is west of UTC, or jump from "1 day" to "0 days" at a non-midnight local time. After midnight local on the start date, the locked tile may still display "Unlocks in 1 day" because `Math.ceil` of a sub-day UTC-vs-local delta rounds up.
- **Root cause:**
  ```tsx
  const calculateDaysUntilUnlock = (startDate: Date): number => {
    const now = new Date();
    const start = new Date(startDate);
    return Math.max(0, Math.ceil((start.getTime() - now.getTime()) / MS_PER_DAY));
  };
  ```
  `Math.ceil` on millisecond deltas is not a day count — a difference of 1.01 days rounds up to 2, a difference of 0.01 days rounds up to 1. The function should compare calendar dates, not wall-clock millisecond deltas.
- **Fix:** Normalize both dates to local midnight before subtracting: `const startMid = new Date(start.getFullYear(), start.getMonth(), start.getDate()); const nowMid = new Date(today...);` then `Math.round((startMid - nowMid) / MS_PER_DAY)`. Keep the display consistent with the locked/unlocked determination used elsewhere (`isEarlyUnlocked`, `lockUnstartedHabits`).

### BUG-FE-HABIT-007 — Locked tile missing accessibilityRole, accessibilityHint, and unlock long-press has no a11y affordance; touch targets below 44pt
- **Severity:** Medium
- **Component:** `frontend/src/features/Habits/HabitTile.tsx:554-589` (`LockedTile`), `HabitTile.tsx:100-143` (`GoalMarker`)
- **Symptom:** Screen-reader users cannot discover the "long-press to unlock early" affordance — it's only in an `Alert` that fires after the gesture. The locked tile exposes `accessibilityLabel={"${name} locked"}` but no `accessibilityHint` describing the long-press, no `accessibilityRole="button"`, and no explicit action. GoalMarker buttons are 12x12pt — far below the WCAG 2.5.5 / Apple HIG 44x44pt minimum, and they only respond to `onPressIn`/`onPressOut`/`onMouseEnter` — on Android there is no mouse, and `onPressIn` fires on any touch-down including accidental scrolls.
- **Root cause:**
  ```tsx
  <TouchableOpacity testID="marker-${tier}"
    onPressIn={() => setTooltip(tier)}
    onPressOut={() => setTooltip(null)}
    ...
    style={{ width: 12, height: 12, borderRadius: 6, ... }}
  />
  ```
  Also the locked `<TouchableOpacity>` lacks `accessibilityRole` and `accessibilityActions` (`activate` + `longPress`), so VoiceOver/TalkBack users cannot trigger the early-unlock Alert at all.
- **Fix:** Add `accessibilityRole="button"`, `accessibilityHint="Long-press to unlock this habit early"`, and an `accessibilityActions=[{name:'longpress', label:'Unlock early'}]` handler. For GoalMarker, wrap the visible 12pt dot in a 44pt `hitSlop` or transparent padding, and use `onPress` with a tooltip toggle rather than pressIn/pressOut.

### BUG-FE-HABIT-008 — useModalCoordinator.open resets ALL modal flags unconditionally, closing user-opened modals when a child opens its own modal
- **Severity:** Medium
- **Component:** `frontend/src/features/Habits/hooks/useModalCoordinator.ts:44-47`
- **Symptom:** `open('reorder')` from `HabitSettingsModal` spreads `INITIAL_STATE` first, closing settings even though the caller already issued `modals.close('settings')` first (which relies on `prev`). But any downstream modal that tries to open while settings is visible — e.g. a nested confirm in GoalModal — will silently close the outer modal because `open` does `setModals({ ...INITIAL_STATE, [name]: true })`. This also means a fast double-tap on two different menu items opens the second and closes the first even if they were meant to stack. Additionally, `emojiPicker` is declared in the `ModalName` union but `ModalState` includes it — the `close` callback uses functional update while `open` replaces — the semantics are inconsistent and a batched React 18 render where `close('settings')` and `open('reorder')` coincide can end up with both flags false because `open` sees `INITIAL_STATE` (not `prev`).
- **Root cause:**
  ```tsx
  const open = useCallback((name: ModalName) => {
    setModals({ ...INITIAL_STATE, [name]: true });  // ignores prev state
    setMenu(false);
  }, []);
  const close = useCallback((name: ModalName) => {
    setModals((prev) => ({ ...prev, [name]: false }));  // uses prev — inconsistent
  }, []);
  ```
  Because `open` doesn't use a functional updater, any in-flight state change is clobbered. The invariant "only one modal open at a time" is enforced here, but it's implemented fragilely — a stacked modal pattern (confirm-in-modal) cannot work.
- **Fix:** Use a functional updater `setModals((prev) => ({ ...INITIAL_STATE, [name]: true }))` for consistency. Consider an explicit `modalStack: ModalName[]` so stacked modals are supported, and so closing the top of the stack restores the previous one.


---

## Habits — Onboarding modal

### BUG-FE-HABIT-101 — Onboarding state persists across modal close/reopen; completion does not reset step/habits, enabling re-trigger with stale data
- **Severity:** High
- **Component:** `frontend/src/features/Habits/components/OnboardingModal.tsx:808-811, 928-956, 1130-1163`
- **Symptom:** After the user finishes onboarding (clicks "Done") or is closed programmatically, re-opening the modal resumes at the last `step` (e.g., step 5 Templates) with the previously saved `habits`, `startDate`, `goalGroupTemplates`, and reveal animation state (`hasRevealedOnce.current === true`). This allows re-triggering completion on already-persisted habits, or being stuck on an orphaned final step with no way back to step 1.
- **Root cause:**
  ```tsx
  const handleFinish = () => {
    onSaveHabits(habits);
    onClose();
  };
  // ...
  const useComposedState = (onClose, onSaveHabits) => {
    const [step, setStep] = useState(1);          // initial-only; never reset on close
    const [habits, setHabits] = useState([]);
    // no reset on `visible` transitions
  };
  ```
  `useOnboardingState` lives in the parent-rendered `OnboardingModal` component and is never unmounted (the `Modal` merely hides). There is no `useEffect([visible])` that clears `step`, `habits`, `startDate`, `goalGroupTemplates`, `hasRevealedOnce`, `unsortedHabits`, or `revealedScoreCount` on close or successful finish. Only `handleConfirmDiscard` performs a partial reset (step + habits), and only on the discard path.
- **Fix:** Either (a) unmount the state by gating `useOnboardingState` inside a child component that is only rendered when `visible === true`, or (b) add `useEffect(() => { if (!visible) { setStep(1); setHabits([]); setStartDate(new Date()); setGoalGroupTemplates([]); reveal.hasRevealedOnce.current = false; setUnsortedHabits([]); setRevealedScoreCount(0); setShowEmojiPicker(false); setSelectedHabitIndex(null); } }, [visible])`. Also reset inside `handleFinish` before `onClose()` so the "completed" flag is authoritative.

### BUG-FE-HABIT-102 — Count-warning dialog "Keep Adding" loses focus and the overlay press also triggers the discard dialog, producing double-modal state
- **Severity:** Medium
- **Component:** `frontend/src/features/Habits/components/OnboardingModal.tsx:762-765, 1113-1127, 1141-1155`
- **Symptom:** When the user clicks Continue with < 10 habits, `showCountWarning` opens; if they tap outside the count dialog (or press back on Android), the overlay click handler on `onboarding-overlay` and the `onRequestClose` on the outer Modal both call `handleAttemptClose`, queuing the discard dialog under the open warning. The user can be left with two stacked confirm dialogs. Additionally, if the count dialog is dismissed via Cancel, focus is never returned to the input (`inputRef.current?.focus()` is not called), so screen-reader users lose their place.
- **Root cause:**
  ```tsx
  const handleContinuePress = () => {
    if (habits.length < MAX_HABITS) setShowCountWarning(true);
    else setStep(2);
  };
  // Outer modal has:
  onPress={s.handleAttemptClose}  // on overlay AND on close X
  onRequestClose={s.handleAttemptClose}
  ```
  The outer `onRequestClose` fires even while `showCountWarning` is `true`, because the warning is a sibling `Modal`, not a nested one. There is no guard `if (showCountWarning || showDiscardDialog) return;` on `handleAttemptClose`.
- **Fix:** Short-circuit `handleAttemptClose` when any secondary dialog is open: `if (showCountWarning || showDiscardDialog || showEmojiPicker) return;`. On "Keep Adding" cancel, also call `inputRef.current?.focus()` to restore focus. Consider rendering the two ConfirmDialogs inside the outer Modal so `onRequestClose` naturally targets them first.

### BUG-FE-HABIT-103 — Step advance races in-flight `goalGroupsApi.list()`: user can hit Done/Back/Close while templates request is pending, causing the catch branch to save+close a completed flow
- **Severity:** High
- **Component:** `frontend/src/features/Habits/components/OnboardingModal.tsx:796-811`
- **Symptom:** `handleGoToTemplates` fires the async templates fetch and optimistically does nothing until it resolves. While in-flight, the user can press Back or Close. If the request then rejects, the `.catch` silently calls `onSaveHabits(habits)` and `onClose()` — saving the partially-configured habit list without the user having reviewed templates, and potentially re-entering close while the discard dialog is already shown. There is no AbortController, no loading state, and no guard against double-click (tapping Continue twice issues two requests and calls `setStep(5)` twice).
- **Root cause:**
  ```tsx
  const handleGoToTemplates = () => {
    goalGroupsApi.list()
      .then((templates) => { setGoalGroupTemplates(...); setStep(5); })
      .catch(() => { onSaveHabits(habits); onClose(); });   // fires even if user already left
  };
  ```
  No `isMounted` ref, no cancellation, no pending flag — and the `onSaveHabits(habits)` fallback uses the `habits` closure captured at call-time, which may be stale if the user kept editing during the await.
- **Fix:** Track a `templatesLoading` flag; disable the Continue button while loading. Use an `AbortController` (or a mounted ref / request-id token) so the late handler becomes a no-op when the user navigated away or closed the modal. Do not auto-save in the catch branch — surface the error inline and let the user retry.

### BUG-FE-HABIT-104 — Reveal-animation effect has stale-closure deps: passing the entire `reveal` object means `startReveal` identity changes retrigger the animation
- **Severity:** High
- **Component:** `frontend/src/features/Habits/components/OnboardingModal.tsx:864-898, 919-923`
- **Symptom:** The reveal sequence can fire twice, or fail to fire on second entry into step 4. `startReveal` is guarded by `hasRevealedOnce.current`, but the effect depends on `reveal` (a fresh object every render). When `unsortedHabits` changes (e.g., user taps Back from step 4 and edits energy, then returns), `hasRevealedOnce.current` is never reset and the reveal silently skips. Conversely, the `step !== 4` effect resets `revealPhase` and `revealedScoreCount` but not `hasRevealedOnce`, so the "second visit" shows the already-sorted habits with no animation — inconsistent with the state model.
- **Root cause:**
  ```tsx
  useEffect(() => {
    if (step === 4 && unsortedHabits.length > 0 && !reveal.hasRevealedOnce.current) {
      reveal.startReveal();
    }
  }, [step, unsortedHabits, reveal]);     // `reveal` is a new object every render
  // And in useRevealAnimation:
  useEffect(() => {
    if (step !== 4) { setRevealPhase('idle'); setRevealedScoreCount(0); }
  }, [step]);                              // does NOT reset hasRevealedOnce
  ```
  The effect also doesn't clean up timers when `step` flips away mid-reveal — `clearTimers` is only invoked on unmount.
- **Fix:** Depend on the stable references: `[step, unsortedHabits, reveal.startReveal, reveal.hasRevealedOnce]` (wrap `startReveal` in `useCallback` — already done — and destructure it). When `step !== 4` mid-reveal, call `clearTimers()` and reset `hasRevealedOnce.current = false` so a re-entry replays or, if the product intent is "animate once ever," persist a deterministic boolean and skip the effect entirely. Also clear timers inside the `step !== 4` effect.

### BUG-FE-HABIT-105 — `handleAddHabit` trims but does not dedupe or validate length; `createNewHabit` ID collision on rapid taps
- **Severity:** Medium
- **Component:** `frontend/src/features/Habits/components/OnboardingModal.tsx:719-727, 739-751`
- **Symptom:** (a) User can add two habits named "Meditate" (case-identical), breaking `keyExtractor={(item) => item.id}` uniqueness when `id` also collides. (b) `id: Date.now().toString()` can collide across two taps within the same millisecond (common on web with React 18 auto-batching), crashing `DraggableFlatList` keys and causing `revealStyles`/React warnings. (c) No max-length cap — a 10k-char habit name is accepted and silently truncates in the UI. (d) No disallow-newline/control-char sanitization.
- **Root cause:**
  ```tsx
  const createNewHabit = (name: string): OnboardingHabit => ({
    id: Date.now().toString(),           // collision-prone
    name: name.trim(),                   // no length cap, no dedupe
    ...
  });
  const handleAddHabit = () => {
    if (newHabitName.trim() === '') return;
    if (habits.length >= MAX_HABITS) { setError(...); return; }
    setHabits((prev) => [...prev, createNewHabit(newHabitName)]);
  };
  ```
- **Fix:** Generate IDs with a monotonically increasing counter or `crypto.randomUUID()` (with fallback). Dedupe case-insensitively before append and surface an inline error. Enforce a reasonable max length (e.g., 80 chars) in both the TextInput (`maxLength`) and state. Strip newlines/tabs.

### BUG-FE-HABIT-106 — No focus management or screen-reader announcement on step change; emoji overlay is not a focus-trapped modal
- **Severity:** Medium
- **Component:** `frontend/src/features/Habits/components/OnboardingModal.tsx:445-461, 568-570, 628-630, 1055-1097`
- **Symptom:** (a) When `step` changes, only the `ScrollView` is scrolled to top — there is no `AccessibilityInfo.announceForAccessibility` and no programmatic focus move to the new step's heading. Screen-reader users hear nothing when advancing. (b) The emoji picker overlay (`ReorderEmojiOverlay`) is a plain `<View>` layered over the DraggableFlatList; it is not a `Modal`, has no focus trap, no `accessibilityViewIsModal`, no Escape handler, and the underlying list remains keyboard-focusable. (c) The Continue button uses no `accessibilityRole="button"` on most tiles, and `HabitChip`'s remove "×" has no `accessibilityLabel`, so VoiceOver reads "times" or nothing.
- **Root cause:**
  ```tsx
  // step-change effect only scrolls:
  useEffect(() => {
    if (step === 2 || step === 3) scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [step, scrollRef]);
  // Emoji overlay:
  const ReorderEmojiOverlay = ({ onCloseEmoji, onEmojiSelected }) => (
    <View style={styles.emojiPickerModal}>...</View>   // not a Modal; no focus trap
  );
  ```
- **Fix:** On step change, call `AccessibilityInfo.announceForAccessibility(<step title>)` and set `accessibilityAutoFocus`/programmatic focus on the heading (`findNodeHandle` + `AccessibilityInfo.setAccessibilityFocus`). Wrap `ReorderEmojiOverlay` in `<Modal transparent animationType="fade" onRequestClose={onCloseEmoji}>` with `accessibilityViewIsModal`. Add `accessibilityLabel="Remove {habit.name}"` to the chip remove button and `accessibilityRole="button"` to touchable tiles.


---

## Habits — other modals, services, utils

### BUG-FE-HABIT-201 — `parseEnergyValue` silently coerces non-numeric input to 0 and accepts floats
- **Severity:** High
- **Component:** `frontend/src/features/Habits/components/HabitSettingsModal.tsx:31-34, 50-67`
- **Symptom:** Typing a non-numeric character, a minus sign, or a decimal into the Cost/Return fields saves a bogus `0` (or a truncated integer) without any validation feedback. Clearing the field replaces the current value with `0` the moment it is edited, forcing the user to retype.
- **Root cause:**
  ```tsx
  const parseEnergyValue = (text: string): number | null => {
    const value = parseInt(text) || 0;   // "" and "abc" both collapse to 0, not null
    return value >= ENERGY_MIN && value <= ENERGY_MAX ? value : null;
  };
  ```
  `parseInt(text) || 0` treats `NaN` and a legitimate user-entered `0` identically and discards the pending "in-progress" state (e.g. `"-"` while typing `-3`). Because the field is controlled (`value={habit.energy_cost.toString()}`), the user sees the stale value flash back and loses intermediate keystrokes. There is also no decimal-rejection — `parseInt("2.9")` silently becomes `2`.
- **Fix:** Keep the raw text in local state while editing, commit on blur/debounce, and use `Number.parseInt(text, 10)` + explicit `Number.isFinite` + `Number.isInteger` checks. Return `null` distinctly from `0`, and surface a red border + message when the parse fails rather than silently snapping to the previous value.

### BUG-FE-HABIT-202 — "Delete Habit" confirmation is fine, but "Reset start date" path wipes all completions with no confirmation
- **Severity:** Critical
- **Component:** `frontend/src/features/Habits/components/MissedDaysModal.tsx:72-79` + `frontend/src/features/Habits/services/habitManager.ts:198-204, 459-461`
- **Symptom:** Tapping "Set new start date" and picking any day immediately calls `onNewStartDate`, which invokes `resetHabitStart`, zeroing `streak`, clearing `last_completion_date`, and destroying the entire `completions` array — no "Are you sure?" dialog, no undo. A mis-tap on a calendar day permanently erases weeks of logged history.
- **Root cause:**
  ```tsx
  const handleDateSelect = (date: DateData) => {
    setSelectedDate(new Date(date.dateString));
    setShowCalendar(false);
    if (habit.id) {
      onNewStartDate(habit.id, new Date(date.dateString));  // immediate, destructive
      onClose();
    }
  };
  // service:
  const resetHabitStart = (habit: Habit, newDate: Date): Habit => ({
    ...habit, start_date: newDate, streak: 0,
    last_completion_date: undefined, completions: [],
  });
  ```
  The user expects a date picker to merely "preview" their choice; the pattern in other modals (SettingsModal delete) wraps destructive actions in `Alert.alert`. Here the calendar tap itself is the point of no return, and the service destroys completions rather than just shifting the start date forward.
- **Fix:** After `handleDateSelect`, show an `Alert.alert('Reset start date', 'This will clear your streak and completion history. Continue?', [cancel, { style: 'destructive' ... }])`. Better still, change `resetHabitStart` to preserve completions dated after `newDate` (only reset streak/last-completion) so the destructive operation is partial and recoverable.

### BUG-FE-HABIT-203 — StatsModal division-by-zero + no empty-state when a habit has <2 completions
- **Severity:** High
- **Component:** `frontend/src/features/Habits/HabitUtils.ts:349-355, 357-369` + `frontend/src/features/Habits/components/StatsModal.tsx:185-208`
- **Symptom:** For a habit with zero or one completion, `LineChart`/`BarChart` receive arrays of `[0,0,0,0,0,0,0]` that `react-native-chart-kit` renders as `NaN` gridlines (all values equal); the calendar tab shows "Completion Rate: 0%" even when the single completion is today. For same-day duplicate completions (common when a user logs twice in one session), `computeCompletionRate` returns `1/1 = 100%` while `computeLongestStreak` returns `1` — both numerically fine but the ratio is misleading because `spanDays` collapses to 1.
- **Root cause:**
  ```ts
  const spanDays = Math.floor((lastDay.getTime() - firstDay.getTime()) / MS_PER_DAY) + 1;
  return spanDays > 0 ? totalUniqueDays / spanDays : 0;
  ```
  `spanDays > 0` always holds (the `+ 1`), so the guard is a no-op — the real edge case (single-day) is never detected. Separately, `buildLineData`/`buildBarData` have no guard for all-zero arrays, and `StatsContent` renders the charts even while `loading` is true (the spinner sits *above* a stale/empty chart). There is no empty-state fallback when `stats.values.every(v => v === 0)`.
- **Fix:** In `computeCompletionRate`, return `null` (or a typed `"insufficient-data"` sentinel) when `sortedDays.length < 2`, and render `"—"` in the UI instead of `0%`. In `StatsContent`, branch on `loading || stats.totalCompletions === 0` and render an explicit empty-state panel ("Log a completion to see stats") instead of the charts.

### BUG-FE-HABIT-204 — ReorderHabitsModal: `useEffect` overwrites user's manual drag order on every re-render of `habits`
- **Severity:** High
- **Component:** `frontend/src/features/Habits/components/ReorderHabitsModal.tsx:107-117`
- **Symptom:** User drags habits into a custom order, then something upstream triggers a new `habits` prop reference (e.g. a polling refresh, an unrelated toast, a notification firing). The `useEffect` re-runs, re-sorts by `STAGE_ORDER`, and throws away the user's in-progress drag. This is also a race: if `onSaveOrder` is fired while the drag is still reconciling with the server, the local state and server state diverge silently.
- **Root cause:**
  ```tsx
  useEffect(() => {
    if (!visible || habits.length === 0) return;
    const sortedHabits = [...habits].sort(
      (a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage),
    );
    setOrderedHabits(updateStartDates(sortedHabits, startDate));
  }, [visible, habits, startDate]);  // re-runs on every habits identity change
  ```
  Including `habits` (array identity, not content) in the deps guarantees the effect resets the local drag buffer on any upstream store update. `onSaveOrder` in `habitManager.saveHabitOrder` also doesn't hit the API (line 413-416) — the reorder is purely local, so a refetch from the server immediately undoes it.
- **Fix:** Seed `orderedHabits` only once when the modal transitions from `visible=false` → `visible=true` (use a ref or key off `visible` alone). Persist the reorder server-side in `habitManager.saveHabitOrder` (add a `habitsApi.reorder(orderedIds)` call) and use `revertOnFailure` to roll back if the request fails, matching the pattern used for `updateHabit`/`deleteHabit`.

### BUG-FE-HABIT-205 — `habitManager.logUnit`: optimistic update not rolled back on failure, and pending check-in payload drops `timestamp` on replay
- **Severity:** High
- **Component:** `frontend/src/features/Habits/services/habitManager.ts:423-453` + `346-374`
- **Symptom:** Two concurrent-write races: (1) When `goalCompletionsApi.create` fails, `savePendingCheckIn` succeeds *and* `revertOnFailure` fires — so the user sees the progress bar snap backward, but a duplicate check-in is queued that will re-apply the same completion on next `loadHabits`. (2) On reconnect, `loadHabits` replays pending check-ins with only `{ goal_id, did_complete }`, silently dropping the saved `timestamp` — so a completion logged on Monday while offline is recorded as "now" when the user reconnects on Thursday, corrupting streak calculations.
- **Root cause:**
  ```ts
  goalCompletionsApi.create(pendingPayload).catch((err: unknown) => {
    void savePendingCheckIn({ ...pendingPayload, timestamp: new Date().toISOString() });
    revertOnFailure(prev, "…queued and will retry…")(err);  // reverts optimistic state
  });
  // …on replay:
  for (const checkIn of pending) {
    await goalCompletionsApi.create({
      goal_id: checkIn.goal_id,
      did_complete: checkIn.did_complete,   // timestamp dropped
    });
  }
  ```
  Reverting the optimistic state while also queueing the check-in means the UI says "not logged" but the queue says "logged" — the next refresh resurrects the completion out of order. On replay the stored `timestamp` is never forwarded to the API.
- **Fix:** Decide on one recovery policy: either keep the optimistic state *and* queue (don't call `revertOnFailure`), toast a warning, and let the replay reconcile — or roll back AND don't queue. Forward `checkIn.timestamp` in the replay loop (`goalCompletionsApi.create` must accept an explicit timestamp). Also wrap `clearPendingCheckIns` so a partial-success replay only removes the check-ins that actually succeeded (current code `return`s from the first failure with unprocessed items still queued but never clears the successful prefix — on next run they'll be duplicated).

### BUG-FE-HABIT-206 — `calculateHabitStartDate` uses UTC arithmetic but callers consume local dates → habits appear on the wrong calendar day across DST / western timezones
- **Severity:** High
- **Component:** `frontend/src/features/Habits/HabitUtils.ts:29-34` + `frontend/src/features/Habits/components/ReorderHabitsModal.tsx:11-18, 40`
- **Symptom:** A user in `America/Los_Angeles` picks "Apr 1" as the first habit start date. `calculateHabitStartDate` increments via `setUTCDate`, so habit 2's start_date is Apr 22 at 00:00 UTC — which renders locally as Apr 21 5pm. `formatDate` then calls `date.toLocaleDateString('en-US')` on that UTC instant and displays "Apr 21", one day earlier than expected. DST transitions (e.g. Mar 13) further shift the boundary by an hour, so a habit can drift by 2 days visually between spring and fall.
- **Root cause:**
  ```ts
  export const calculateHabitStartDate = (baseDate: Date, index: number): Date => {
    const date = new Date(baseDate);
    const offset = STAGE_DURATIONS_DAYS.slice(0, index).reduce((s, d) => s + d, 0);
    date.setUTCDate(date.getUTCDate() + offset);   // UTC arithmetic
    return date;
  };
  // formatDate -> toLocaleDateString uses local TZ, so UTC→local conversion at
  // display time shifts the day by up to -1 for users west of UTC.
  ```
  The same inconsistency appears in `habitManager.lockUnstartedHabits` (line 480-488), which compares `new Date(h.start_date).getTime()` against `Date.now()` — a habit scheduled for local-midnight Apr 1 unlocks at 5pm Mar 31 for PST users.
- **Fix:** Pick ONE convention and enforce it throughout. Recommended: store `start_date` as a date-only string (`YYYY-MM-DD`) and never convert to a JS `Date` except at the display layer. If `Date` must be used, construct from `new Date(y, m, d)` (local) and use `date.setDate(date.getDate() + offset)` so DST is respected. Update `formatDate` to operate on the string directly, and update `lockUnstartedHabits` to compare date strings (`todayStr >= habit.start_date`) rather than timestamps.

### BUG-FE-HABIT-207 — `computeCurrentStreak` never checks whether the most recent completion is "today" or "yesterday" → streak shows stale value forever
- **Severity:** Medium
- **Component:** `frontend/src/features/Habits/HabitUtils.ts:357-369`
- **Symptom:** A user completes a habit every day for 30 days, then stops. The StatsModal "Current Streak" correctly shows 30 on day 30, but on day 60 (a month of no completions) it still shows 30 — the function only measures gaps *between* recorded days, not the gap between the last completion and "now". The streak should reset to 0 once "today" is more than 1 day after the most recent completion.
- **Root cause:**
  ```ts
  const computeCurrentStreak = (sortedDays: Date[]): number => {
    if (sortedDays.length === 0) return 0;
    let streak = 1;
    for (let i = sortedDays.length - 2; i >= 0; i--) {
      const diff = (sortedDays[i + 1]!.getTime() - sortedDays[i]!.getTime()) / MS_PER_DAY;
      if (diff === 1) streak += 1; else break;
    }
    return streak;   // never compared to "today"
  };
  ```
  Combined with `diff === 1` (strict equality on a float derived from `getTime()`), any DST-hour drift makes `diff` become `0.9583…` or `1.0417…` and breaks the streak silently mid-sequence, even for users who completed every day.
- **Fix:** Before the loop, compute `daysSinceLast = floor((todayUTC - sortedDays[last]) / MS_PER_DAY)`. If `daysSinceLast > 1`, return `0`. Inside the loop, use `Math.round(diff) === 1` (or compare UTC day-keys directly) so DST hour shifts don't poison the comparison. Add a unit test that logs completions across a DST boundary and asserts the streak is unbroken.


---

## Journal — main screen

### BUG-FE-JOURNAL-001 — Streaming chunks are never cancelled when the user navigates away
- **Severity:** High
- **Component:** `frontend/src/features/Journal/JournalScreen.tsx:432-465, 510-541`
- **Symptom:** If the user backs out of the Journal mid-stream (swipe away, tab change, or logout), the SSE fetch keeps running in the background. The closure inside `onChunk` keeps calling `setMessages` on an unmounted tree (yielding a React warning), consumes the user's wallet, and never fires `onComplete`, so the "thinking" state is left dangling if they return.
- **Root cause:**
  ```tsx
  await botmasonApi.chatStream(
    { message: text },
    {
      onChunk: (chunk) => { ... deps.actions.appendChunk(botPlaceholderId, chunk); },
      onComplete: (result) => { ... },
      onStreamError: (err) => { outcome.streamError = err.detail; },
    },
  );
  ```
  `runChatStream` accepts no `AbortSignal` and `useBotSend` never creates an `AbortController`. There is no cleanup in `useEffect`/`useJournalComposer` to abort in-flight streams on unmount, so a stream started at t=0 happily writes chunks long after the user has left. Pairs with backend BUG-BM-006 (client cancellation): even the server keeps burning tokens because no RST arrives.
- **Fix:** Thread an `AbortController` through `useBotSend`, stash the latest controller in a ref, pass `controller.signal` into `botmasonApi.chatStream`, and call `controller.abort()` in a `useEffect` cleanup (and in the retry path) so a new send also cancels a prior in-flight stream. Guard chunk/complete callbacks with an `isMounted` ref or skip state updates when `signal.aborted`.

### BUG-FE-JOURNAL-002 — Optimistic user message is orphaned when the bot stream throws before the first chunk
- **Severity:** High
- **Component:** `frontend/src/features/Journal/JournalScreen.tsx:476-501, 510-541`
- **Symptom:** When `chatStream` throws synchronously (auth, DNS failure, 500), the bot placeholder is removed correctly but the user's optimistic bubble is left with a `_retryText` — except that the optimistic `id` is a negative timestamp, and any retry that succeeds will NOT replace it (the server returns a different positive id via `bot_entry_id`, not the echoed user id). The user's own message is therefore never reconciled with the server-side journal row and will vanish on next reload.
- **Root cause:**
  ```tsx
  } catch (err) {
    await handleStreamError(err, text, tag, optimisticUserId, botPlaceholder.id, deps);
  }
  // handleStreamError → markErrored leaves the optimistic user message in place
  // with its negative timestamp id, with no server reconciliation scheduled.
  ```
  There is no call to persist the user's text via `journalApi.create` on the bot-failure path (unless the 402 `insufficient_offerings` branch fires). On page reload the server-side list will not include the user's message, so the UI silently drops it.
- **Fix:** In `handleStreamError` (non-402, non-streaming-unsupported branches), also call `sendFreeform(text, tag, optimisticUserId)` after marking the bubble errored so the user's words are persisted server-side; alternatively pre-persist the user message before calling `sendWithBot` and only reconcile the bot placeholder on failure.

### BUG-FE-JOURNAL-003 — Duplicate-id collision when retrying errored bot send
- **Severity:** High
- **Component:** `frontend/src/features/Journal/JournalScreen.tsx:349-362, 555-570, 846-854`
- **Symptom:** If the user double-taps Retry (or taps Retry while another retry's stream is still starting) the second call creates a new bot placeholder with `id = -(Date.now() + 1)` that can collide with either the original user optimistic id (`-Date.now()`) or a sibling retry's placeholder id if two clicks occur in the same millisecond. The FlatList `keyExtractor` returns duplicate keys and React Native logs a "Encountered two children with the same key" warning; `appendChunk` writes to the wrong bubble.
- **Root cause:**
  ```tsx
  function createBotPlaceholder(): ChatMessage {
    return { id: -(Date.now() + 1), ... };
  }
  function buildOptimisticMessage(...): ChatMessage {
    return { id: -Date.now(), ... };
  }
  ```
  Ids are derived from `Date.now()` which has ~1ms resolution, and the +1 offset is insufficient once retries are in flight. There is also no debounce/guard on the retry button, so two taps within one tick both call `sendWithBot` with the same errored-bubble id.
- **Fix:** Use a monotonic counter (e.g., `useRef(-1)` decremented on every allocation) or `crypto.randomUUID()`-style string ids for optimistic messages, and disable the retry button (or set a `_retrying` flag on the message) while a retry is in progress.

### BUG-FE-JOURNAL-004 — Search query triggers list refetch on every keystroke with no debounce
- **Severity:** Medium
- **Component:** `frontend/src/features/Journal/JournalScreen.tsx:237-277, 757-771, 936-952`
- **Symptom:** `useJournalInit` depends on `loadMessages`, which is recreated whenever `searchQuery` changes. Every keystroke in `SearchBar` therefore re-runs the full `loadMessages(0)` + `loadPrompt()` + `loadUsage()` trio, flashing the loading spinner (line 944) and cancelling the user's typing flow. On slow networks this also stampedes the backend with N concurrent `/journal?search=...` calls whose responses race.
- **Root cause:**
  ```tsx
  useEffect(() => {
    const init = async () => {
      setLoading(true);
      await Promise.all([loadMessages(0), loadPrompt(), loadUsage()]);
      setLoading(false);
    };
    void init();
  }, [loadMessages, loadPrompt, loadUsage, setLoading]);
  ```
  `loadMessages` is wrapped in `useCallback` with `[searchQuery, activeTag, ...]` dependencies, so the effect fires on every search character. There is no debounce on `setSearchQuery`, and no request-sequence guard to discard stale responses.
- **Fix:** Debounce `searchQuery` (e.g. 250ms via a `useDebouncedValue` hook) before passing it to `useJournalComposer`; split init from refetch (run `loadPrompt`/`loadUsage` once in a mount-only effect, refetch only `loadMessages` on debounced query/tag change); add a request-token ref to drop out-of-order responses.

### BUG-FE-JOURNAL-005 — `useBotSend` recomputes `sendWithBot` on every render because `deps` is a fresh object literal
- **Severity:** Medium
- **Component:** `frontend/src/features/Journal/JournalScreen.tsx:503-544, 857-874`
- **Symptom:** Every parent render rebuilds the `deps` object passed to `useBotSend`, which makes `sendWithBot`'s `useCallback` cache miss on every render. That cascades into `handleSend`/`handleRetry` being new references each render, so `ChatInput` and `JournalMessageList` (which accept them as props) re-render and their memoised `renderItem` cache is invalidated — every keystroke/scroll re-creates every `MessageBubble`.
- **Root cause:**
  ```tsx
  function useBotSendWithActions(msgList, side, sendFreeform) {
    return useBotSend({
      actions: { prependMessage: msgList.prependMessage, ... },
      setOfferingBalance: side.setOfferingBalance,
      setRemainingMessages: side.setRemainingMessages,
      sendFreeform,
    });
  }
  // deps is a fresh literal every render → useCallback([deps]) never reuses
  ```
  `useCallback(async ..., [deps])` only memoises against the same object reference, and here the object is freshly allocated on each call.
- **Fix:** Either inline the individual setters/actions into the `useCallback` dependency array (stable because they come from `useState` and `useCallback`), or wrap the `deps` object construction in `useMemo` keyed on the underlying stable references.

### BUG-FE-JOURNAL-006 — No draft persistence: nav-away loses in-progress reflection
- **Severity:** Medium
- **Component:** `frontend/src/features/Journal/JournalScreen.tsx:936-979`
- **Symptom:** `ChatInput` is uncontrolled by this screen — nothing persists a half-typed message to AsyncStorage. If the user navigates to another tab (even accidentally), gets a phone call, or the OS backgrounds the app and React Native unmounts the screen, the draft is gone. For a journaling product this is the worst possible data-loss surface.
- **Root cause:**
  ```tsx
  <ChatInput onSend={j.handleSend} disabled={j.sending} initialTag={rp.contextTag} />
  ```
  No `draft`/`onDraftChange` prop and no effect wiring to `AsyncStorage`. The screen also doesn't key the draft by route context (e.g., a course-reflection draft would be clobbered by a freeform draft).
- **Fix:** Promote the draft text into `JournalScreen` state (or a persisted Zustand slice) keyed by `{practiceSessionId, contextTag}`, read from `AsyncStorage` in a mount effect, throttle-write on change (500ms), and clear on successful send.

### BUG-FE-JOURNAL-007 — `getItemLayout` on an inverted variable-height list corrupts scroll and `onEndReached`
- **Severity:** Medium
- **Component:** `frontend/src/features/Journal/JournalScreen.tsx:586-594, 679-697`
- **Symptom:** `journalGetItemLayout` claims every message is exactly 84px tall. In reality messages wrap to many lines (long bot replies, multi-paragraph reflections), so the computed `offset` quickly diverges from reality. On an `inverted` FlatList this makes `onEndReached` fire at the wrong scroll position (either spam-firing near the bottom or never firing, stalling pagination), breaks `scrollToIndex`, and causes visible jank when streaming chunks grow a bubble past 84px.
- **Root cause:**
  ```tsx
  const ESTIMATED_MESSAGE_HEIGHT = 84;
  const journalGetItemLayout = (_data, index) => ({
    length: ESTIMATED_MESSAGE_HEIGHT,
    offset: ESTIMATED_MESSAGE_HEIGHT * index,
    index,
  });
  ```
  `getItemLayout` must return exact heights — providing approximate values is documented as incorrect and produces the exact pagination/scroll bugs described. The inline contentContainerStyle `{ flexGrow: 1 }` on line 687 is also a fresh object each render (unrelated re-render cost).
- **Fix:** Drop `getItemLayout` entirely (variable-height chat bubbles are exactly the case where it should not be used); rely on FlatList's default virtualization. If O(1) jumps are needed, switch to `estimatedItemSize` with FlashList or maintain per-id measured heights in a ref via `onLayout`. Move the conditional `flexGrow` style into a memoised `StyleSheet` entry.

### BUG-FE-JOURNAL-008 — `loadMessages` swallows errors with `console.error`, leaving the user staring at a blank journal
- **Severity:** Medium
- **Component:** `frontend/src/features/Journal/JournalScreen.tsx:248-277, 757-771`
- **Symptom:** If `journalApi.list` fails (auth expiry mid-session, server 500, offline), the catch branch logs to the console but never sets error state. The screen finishes its init effect, `loading` flips to false, and the user sees the empty "Your Journal Awaits" state as if they had zero entries — an alarming and incorrect signal. There is also no retry UI.
- **Root cause:**
  ```tsx
  } catch (err) {
    console.error('Failed to load journal messages:', err);
  }
  ```
  Same anti-pattern in `loadPrompt` (line 290), `loadUsage` (line 303), and `respond` (line 790). None surface an error to the user or offer a retry; `loadPrompt`'s 401 will also not trigger re-auth because it's swallowed.
- **Fix:** Introduce a `loadError` state; on catch, set it with a mapped user-facing message and render an error banner with a "Try again" button that re-invokes `loadMessages(0)`. Distinguish 401 (bubble up to AuthContext for logout) from transient errors so auth expiry doesn't silently present an empty journal.


---

## Journal — ancillary components

### BUG-FE-JOURNAL-101 — ChatInput allows unbounded-length messages and has no max-length guard
- **Severity:** High
- **Component:** `frontend/src/features/Journal/ChatInput.tsx:69-79,104-122`
- **Symptom:** A user can paste or type a reflection of arbitrary length (e.g. tens of thousands of characters). The `TextInput` does not enforce `maxLength`, the trim-check only rejects empty strings, and the parent API call will then either time out, be rejected by the backend, or succeed with an absurdly large body that wrecks the chat render cost.
- **Root cause:**
  ```tsx
  <TextInput
    style={styles.textInput}
    value={text}
    onChangeText={onChangeText}
    placeholder="Write a reflection..."
    multiline
    editable={!disabled}
  />
  // ...
  const canSend = text.trim().length > 0 && !disabled;
  ```
  There is no upper bound on input length and `canSend` only gates on non-empty-after-trim. Backend journal-message endpoints enforce a limit (typically 5k chars) but the client never surfaces it, so long messages silently fail server-side.
- **Fix:** Define a shared `JOURNAL_MAX_CHARS` constant, pass it to `<TextInput maxLength={JOURNAL_MAX_CHARS}>`, and include `trimmed.length <= JOURNAL_MAX_CHARS` in the `canSend` calc. Render a subtle counter (e.g. `{text.length}/{JOURNAL_MAX_CHARS}`) once the user crosses 80% so the limit is not a surprise at send time.

### BUG-FE-JOURNAL-102 — ChatInput `handleSend` can double-submit under rapid taps / re-render races
- **Severity:** High
- **Component:** `frontend/src/features/Journal/ChatInput.tsx:109-122`
- **Symptom:** If the user double-taps the send button, or if `onSend` is asynchronous and the parent re-renders with `disabled={false}` late, two identical messages are submitted. The component never disables the button during the in-flight send; it relies entirely on the parent flipping `disabled` synchronously, which is not guaranteed.
- **Root cause:**
  ```tsx
  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    onSend(trimmed, selectedTag);
    setText('');
    setSelectedTag(initialTag);
    setShowTagPicker(false);
  }, [text, onSend, selectedTag, initialTag]);

  const canSend = text.trim().length > 0 && !disabled;
  ```
  `setText('')` is a state update that is not applied until the next render; a second tap fired in the same frame still sees the old `text` via closure, re-enters `handleSend`, and calls `onSend` again. There is no `isSubmitting` guard local to the component.
- **Fix:** Add a local ref `const sendingRef = useRef(false)`; at the top of `handleSend` bail out if `sendingRef.current`. Set it to `true` before calling `onSend`, and reset it in a `finally` block (wrap `onSend` so it can return a promise) or via an effect when `disabled` flips back to `false`. Also clear the text *before* calling `onSend(trimmed, ...)` so the closure can't re-read stale state.

### BUG-FE-JOURNAL-103 — MessageBubble appends streaming cursor directly into text, causing copy/selection pollution and a11y readback of a box glyph
- **Severity:** Medium
- **Component:** `frontend/src/features/Journal/MessageBubble.tsx:100-116`
- **Symptom:** When `_streaming` is true the component concatenates the cursor glyph `\u258A` (LEFT FIVE EIGHTHS BLOCK) into the visible message string. Copying the message, selecting text, or having a screen reader announce it all include the "▊" character as if it were part of the content. The timestamp below will also render alongside a message that ends in a block char, and if the stream ends exactly on a newline the cursor floats on its own line.
- **Root cause:**
  ```tsx
  const showCursor = message._streaming === true;
  const bodyText = showCursor ? `${message.message}${STREAMING_CURSOR}` : message.message;
  // ...
  <Text testID={showCursor ? 'streaming-bubble-text' : undefined} ...>
    {bodyText}
  </Text>
  ```
  The cursor is part of the accessible text node, not a sibling element with `accessibilityElementsHidden`.
- **Fix:** Render the cursor as a sibling `<Text>` with `accessibilityElementsHidden` / `importantForAccessibility="no-hide-descendants"` and `selectable={false}`, e.g. `<Text>{message.message}</Text>{showCursor && <Text aria-hidden style={styles.streamCursor}>{STREAMING_CURSOR}</Text>}`. Copy, selection, and screen readers then see only the real message.

### BUG-FE-JOURNAL-104 — MessageBubble does not mark user-vs-bot role or timestamp for screen readers
- **Severity:** Medium
- **Component:** `frontend/src/features/Journal/MessageBubble.tsx:97-125`
- **Symptom:** A blind user navigating the chat hears only the raw message text — they cannot tell who sent it ("you" vs "BotMason") or when. The outer `<View>` has no `accessibilityLabel`, the avatar's "B" Text is spoken literally, and the timestamp is a second sibling Text node that gets announced as an unrelated string "08:14".
- **Root cause:**
  ```tsx
  <View style={[styles.bubbleRow, isUser ? styles.bubbleRowUser : styles.bubbleRowBot]}>
    {!isUser && (<View style={styles.botAvatar}><Text style={styles.botAvatarText}>B</Text></View>)}
    <View style={[styles.bubble, ...]}>
      <Text ...>{bodyText}</Text>
      <BubbleTags ... />
      <Text ...>{formatTimestamp(message.timestamp)}</Text>
  ```
  Nothing declares `accessibilityRole`, `accessibilityLabel`, or groups the children so a screen reader announces "BotMason said X at 08:14".
- **Fix:** Wrap the bubble in an `accessible` View with `accessibilityRole="text"` and a composed `accessibilityLabel` like `${isUser ? 'You' : 'BotMason'} said ${message.message} at ${formatTimestamp(...)}`. Mark the avatar's inner `<Text>` as `accessibilityElementsHidden`. Also add `testID={isUser ? 'bubble-user' : 'bubble-bot'}` so tests can assert role without relying on style classes.

### BUG-FE-JOURNAL-105 — SearchBar race: late debounced callback can clobber query after clear, and `searchQuery` prop changes do not sync local state
- **Severity:** High
- **Component:** `frontend/src/features/Journal/SearchBar.tsx:86-117`
- **Symptom:** Two issues compound: (a) a pending debounced `onSearch` fires *after* the user hit clear, re-issuing a search for the now-stale text; (b) when the parent updates `searchQuery` (e.g. restored from URL or storage), the `useState(searchQuery ?? '')` initializer runs once and later changes are ignored, so the input and the "N results for 'X'" label drift out of sync.
- **Root cause:**
  ```tsx
  const [expanded, setExpanded] = useState(!!searchQuery);
  const [text, setText] = useState(searchQuery ?? '');
  // ...
  const handleClear = useCallback(() => {
    setText('');
    setExpanded(false);
    if (timerRef.current) clearTimeout(timerRef.current);
    onSearch('');
  }, [onSearch]);
  ```
  `handleClear` clears the timer but nothing guards against a `setTimeout` callback that has *already* been scheduled to fire in the same tick (the timer id is still valid, but under certain JS engines and fast typing the handler can be queued). More importantly, `useState` never rehydrates from `searchQuery` on update.
- **Fix:** Track a monotonically-increasing `requestId` ref; inside the debounced callback capture the id at schedule time and compare before calling `onSearch` — drop stale callbacks. Add a `useEffect(() => { setText(searchQuery ?? ''); setExpanded(!!searchQuery); }, [searchQuery])` to sync prop changes. Also clear `timerRef.current = null` after `clearTimeout` so the cleanup path is idempotent.

### BUG-FE-JOURNAL-106 — TagFilter `All` chip is not selectable (noop) and duplicate tag values break `key`
- **Severity:** Medium
- **Component:** `frontend/src/features/Journal/TagFilter.tsx:30-58`
- **Symptom:** Tapping the "All" chip when it is already active does nothing (it calls `onSelectTag(null)` with `null` already set) — that is fine — but tapping "All" also gives no visual confirmation because the handler short-circuits regardless of `isActive`. Additionally, `key={testId}` is stable only because `chip.value` is unique today; if two chips ever shared a value (e.g. a future `null` alias) React would warn and de-dupe silently. More importantly, the chip labels ("Reflections", "Practice Notes", "Habit Notes") differ from the ChatInput `TAG_OPTIONS` labels ("Reflection", "Practice", "Habit") for the *same* `JournalTag` values — users see two different names for the same tag across the feature.
- **Root cause:**
  ```tsx
  const handlePress = () => {
    if (chip.value === null) {
      onSelectTag(null);
    } else {
      onSelectTag(isActive ? null : chip.value);
    }
  };
  ```
  Also: ChatInput.tsx uses `{ value: 'stage_reflection', label: 'Reflection' }` while TagFilter uses `{ value: 'stage_reflection', label: 'Reflections' }`. There is no shared source of truth for `JournalTag → label`.
- **Fix:** Extract a single module-level `JOURNAL_TAG_LABELS: Record<JournalTag, string>` (shared with `MessageBubble.TAG_LABELS` and `ChatInput.TAG_OPTIONS`) and derive both the chip list and the picker from it. Use `key={chip.value ?? 'all'}`. Consider letting the "All" press provide haptic feedback or visual pulse even when already active so the tap is acknowledged.

### BUG-FE-JOURNAL-107 — WeeklyPromptBanner is stateless and will stick around with a stale question after the user responds
- **Severity:** Medium
- **Component:** `frontend/src/features/Journal/WeeklyPromptBanner.tsx:13-29`
- **Symptom:** The banner renders whatever `prompt` the parent passes and offers no dismiss affordance. After the user taps Respond and submits a reply, the parent is responsible for hiding the banner — but if the parent uses a cached prompt list (or if the POST succeeds but the list refetch is slow), the banner lingers, still inviting a response to a prompt the user has already answered. There is also no week-mismatch guard: if `prompt.week_number` differs from the current in-app week (BUG-PROMPT-001 cross-ref), the component still displays it verbatim.
- **Root cause:**
  ```tsx
  <View style={styles.promptBanner} testID="weekly-prompt-banner">
    <Text style={styles.promptLabel}>Week {prompt.week_number} Reflection</Text>
    <Text style={styles.promptQuestion}>{prompt.question}</Text>
    <TouchableOpacity onPress={onRespond} ...>
      <Text>Respond</Text>
    </TouchableOpacity>
  </View>
  ```
  No `onDismiss`, no `responded` prop, no comparison against "current" week, no accessibility label on the outer view describing its role.
- **Fix:** Add optional `onDismiss?: () => void` that renders an X button, a `responded?: boolean` prop that swaps the CTA to a disabled "Responded" chip, and receive `currentWeek: number` so the banner can show a "Past prompt" badge when `prompt.week_number !== currentWeek` instead of misrepresenting a stale prompt as this week's reflection. Wrap in `accessible` with `accessibilityRole="summary"` and `accessibilityLabel={`Week ${prompt.week_number} reflection prompt: ${prompt.question}`}`.

---

## Suggested Remediation Order

1. **BUG-FE-HABIT-205 (Critical)** — Fix `logUnit` pending-queue serialization: persist the full `{ habit_id, delta, timestamp, idempotency_key }` tuple. Pair with BUG-FE-HABIT-001.
2. **BUG-FE-HABIT-001 (Critical)** — Capture rollback state before optimistic update; apply on `catch`. Ensure `AsyncStorage` + store + pending queue all revert together.
3. **BUG-FE-HABIT-207 / -206 / -002 / -006 (High/Medium)** — Centralize date math: one `dateUtils` module that owns "today in user's TZ", "N calendar days ago", etc. Replace every UTC `Math.ceil((a - b) / 86400000)` with `differenceInCalendarDays(a, b, { tz: localTZ })`.
4. **BUG-FE-JOURNAL-001 / -003 (High)** — Wire an `AbortController` per-send; store `message_id` on the signal so cancellation clears the right bubble. Use crypto UUIDs or a monotonic counter to replace `Date.now()`.
5. **BUG-FE-JOURNAL-002 (High)** — On stream failure, either persist the user message server-side before starting the stream, or queue the user message into a pending/retry list so reload doesn't lose it.
6. **BUG-FE-HABIT-008 (High)** — Make `useModalCoordinator.open(modal)` a functional setter that only flips the targeted flag; add a test for "open A, open B, close B, A still open."
7. **BUG-FE-HABIT-202 (High)** — Gate "Reset start date" behind an `Alert.alert` confirm with explicit "this will delete N completions" copy. Consider moving the destructive action into a 2-step flow.
8. **BUG-FE-HABIT-204 (High)** — Remove the `useEffect(() => setLocalOrder(habits))` that stomps drag state; initialize from `habits` once and only sync on modal open.
9. **BUG-FE-HABIT-101 / -103 / -105 (High)** — Reset onboarding state in an `onDismiss`; treat `goalGroupsApi.list()` as "templates-or-empty," not as the signal to auto-save; validate input length + dedupe before `createNewHabit`.
10. **BUG-FE-HABIT-005 / -201 (High)** — Return and persist scheduled notification ids; reject non-integer energy input at parse-time with a user-visible error.
11. **BUG-FE-JOURNAL-101 / -102 (High)** — Enforce `maxLength` on TextInput; disable Send while a previous send is in flight.
12. **BUG-FE-JOURNAL-105 (High)** — Use `useDebounce(value, 300)` and keep local state in sync with the `searchQuery` prop via a controlled pattern.
13. Remaining Medium items — batch into a single "polish" PR: a11y labels/roles, draft persistence via AsyncStorage, `getItemLayout` removal on variable-height inverted lists, stats empty-state, stale banner dismissal, streaming cursor via separate overlay View.

## Cross-References

- **BUG-FE-HABIT-002 / -206 / -207 ↔ BUG-STREAK-002 / BUG-HABIT-005** — Backend streak math and frontend streak display both fall apart on local vs UTC boundaries. Coordinate the fix: backend should return a streak computed in the user's stored TZ, frontend should display it without recomputation.
- **BUG-FE-JOURNAL-001 ↔ BUG-BM-006** — Backend doesn't cancel upstream LLM calls when the client disconnects; frontend doesn't disconnect on nav-away. Either side alone is insufficient — both must be fixed for wallet-leak to close.
- **BUG-FE-JOURNAL-002 / -101 ↔ BUG-BM-012 / BUG-JOURNAL-003** — Optimistic sends + unbounded-length input + unsanitized backend storage are the same pipeline. Idempotency key (BUG-BM-012) on the client + length cap here + bleach on the server (BUG-JOURNAL-003) together close the loop.
- **BUG-FE-JOURNAL-107 ↔ BUG-PROMPT-001 / -002** — Weekly-prompt UI leaks future prompts if backend doesn't gate `/prompts/{week_number}`; frontend banner doesn't refresh after submit. Fix backend first, then make the banner stateful.
- **BUG-FE-HABIT-205 ↔ BUG-HABIT-004** — Backend idempotency and frontend replay correctness go together; add `idempotency_key` end-to-end.
- **BUG-FE-HABIT-204 ↔ BUG-HABIT-*** — Any reorder endpoint should accept the full ordered list, not pairwise swaps; frontend should send the persisted order only after successful drag-end.
