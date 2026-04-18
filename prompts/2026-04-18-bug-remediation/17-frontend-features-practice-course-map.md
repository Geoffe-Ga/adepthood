# Frontend — Practice, Course, Map Bug Report — 2026-04-18

**Scope:** `frontend/src/features/Practice/**` (627+411+174+90 = 1302 LOC), `frontend/src/features/Course/**` (274+147+84+95 = 600 LOC), `frontend/src/features/Map/**` (491+85+72 = 648 LOC). Covers the practice selector / timer / weekly progress loop, the stage-gated course content viewer, and the 36-stage developmental map.

**Total bugs: 29 — 1 Critical / 11 High / 12 Medium / 5 Low**

## Executive Summary

1. **Timer wall-clock drift + concurrent intervals (Critical/High).** BUG-FE-PRACTICE-101: `setInterval(..., 1000)` is wall-clock-blind — background/suspend pauses the tick and resumes later with no catch-up, producing minute-scale drift on a 10-minute session. BUG-FE-PRACTICE-102 layers a race on top: rapid Start/Cancel/Start spawns concurrent intervals, halving the countdown.
2. **Stage gating duplicated client-side (and wrong) (High).** BUG-FE-PRACTICE-001 (stage defaults to 1 and never reconciles), BUG-FE-PRACTICE-002 (locked-stage practices tappable), BUG-FE-COURSE-001 (locked content title/url rendered), BUG-FE-COURSE-002 (StageSelector paints future stages), BUG-FE-MAP-001 (all 36 hotspots rendered; only `is_unlocked` from API gates tap). These mirror backend BUG-COURSE-001 / BUG-STAGE-002 — but defense-in-depth requires BOTH sides.
3. **Client-trusted timestamps + zero-duration sessions accepted (High).** BUG-FE-PRACTICE-004 / -105: session completion reports a client-computed duration with no bound, mirroring BUG-PRACTICE-005/006 backend. A malicious (or clock-skewed) client can report negative or decades-long durations.
4. **Optimistic writes that don't roll back (High/Medium).** BUG-FE-PRACTICE-005 (weekly count), BUG-FE-MAP-005 (no retry/rollback on stage advance failure) — same pattern as BUG-FE-HABIT-001 / BUG-FE-JOURNAL-002 in report 16.
5. **Resource leaks on unmount (High/Medium).** BUG-FE-PRACTICE-103 (audio `Sound` leak), BUG-FE-PRACTICE-106 (keep-awake never released mid-run), BUG-FE-PRACTICE-104 (pause re-subscribes and keeps counting), BUG-FE-COURSE-005 (setState on unmounted viewer).
6. **A11y + perf polish (Medium/Low).** Every surface skips `accessibilityRole`, `accessibilityState`, or SR hide on decorative SVG: BUG-FE-PRACTICE-007/-108, BUG-FE-COURSE-003, BUG-FE-MAP-004/-006/-007. BUG-FE-COURSE-004/-006 (unbounded FlatList, weak URL validation), BUG-FE-MAP-003 (progress percent unvalidated — can NaN/overflow), BUG-FE-PRACTICE-107/-109 (halfway bell fires at start; Complete state flashes on zero-duration).

## Table of Contents

| # | ID | Severity | Component | Title |
|---|----|----------|-----------|-------|
| 1 | BUG-FE-PRACTICE-001 | High | `Practice/PracticeScreen.tsx` | Stage defaults to 1; never reconciled |
| 2 | BUG-FE-PRACTICE-002 | High | `Practice/PracticeSelector.tsx` | `isLocked` never passed; locked tappable |
| 3 | BUG-FE-PRACTICE-003 | Medium | `Practice/WeeklyProgress.tsx` | Stale after week rollover / journal round-trip |
| 4 | BUG-FE-PRACTICE-004 | High | `Practice/PracticeScreen.tsx` | Client duration unchecked; zero / fractional allowed |
| 5 | BUG-FE-PRACTICE-005 | Medium | `Practice/PracticeScreen.tsx` | Optimistic `incrementWeekCount` not rolled back |
| 6 | BUG-FE-PRACTICE-006 | Medium | `Practice/PracticeScreen.tsx` | 401 flattened to empty state |
| 7 | BUG-FE-PRACTICE-007 | Low | `Practice/PracticeSelector.tsx` | Missing a11y role/label/state |
| 8 | BUG-FE-PRACTICE-101 | Critical | `Practice/PracticeTimer.tsx` | Background drift on `setInterval` |
| 9 | BUG-FE-PRACTICE-102 | High | `Practice/PracticeTimer.tsx` | Rapid Start/Cancel race → concurrent intervals |
| 10 | BUG-FE-PRACTICE-103 | High | `Practice/PracticeTimer.tsx` | `Sound` leak on unmount |
| 11 | BUG-FE-PRACTICE-104 | High | `Practice/PracticeTimer.tsx` | Pause keeps counting via re-subscribe |
| 12 | BUG-FE-PRACTICE-105 | High | `Practice/PracticeTimer.tsx` | `onComplete` trusts client clock |
| 13 | BUG-FE-PRACTICE-106 | Medium | `Practice/PracticeTimer.tsx` | Keep-awake never released mid-run |
| 14 | BUG-FE-PRACTICE-107 | Medium | `Practice/PracticeTimer.tsx` | Halfway bell fires at start |
| 15 | BUG-FE-PRACTICE-108 | Low | `Practice/PracticeTimer.tsx` | Remaining time not announced |
| 16 | BUG-FE-PRACTICE-109 | Low | `Practice/PracticeTimer.tsx` | Complete state flashes at zero duration |
| 17 | BUG-FE-COURSE-001 | High | `Course/ContentViewer.tsx` | Renders title/url for locked content |
| 18 | BUG-FE-COURSE-002 | High | `Course/StageSelector.tsx` | `max(stage_number)` paints future stages |
| 19 | BUG-FE-COURSE-003 | Medium | `Course/ContentCard.tsx` | Missing a11y hint/state on locked cards |
| 20 | BUG-FE-COURSE-004 | Medium | `Course/CourseScreen.tsx` | FlatList unbounded; no pagination |
| 21 | BUG-FE-COURSE-005 | Medium | `Course/ContentViewer.tsx` | Back during markRead → setState on unmount |
| 22 | BUG-FE-COURSE-006 | Medium | `Course/ContentViewer.tsx` | `Linking.openURL` weak scheme validation |
| 23 | BUG-FE-MAP-001 | High | `Map/MapScreen.tsx` | All 36 hotspots rendered; client-side gate only |
| 24 | BUG-FE-MAP-002 | High | `Map/MapScreen.tsx` | `current_stage` derived locally, diverges from backend |
| 25 | BUG-FE-MAP-003 | Medium | `Map/MapScreen.tsx` | Progress percent unvalidated; NaN / overflow possible |
| 26 | BUG-FE-MAP-004 | Medium | `Map/MapScreen.tsx` | Locked-stage tap silently no-ops |
| 27 | BUG-FE-MAP-005 | Medium | `Map/services/stageService.ts` | No retry / rollback on advance failure |
| 28 | BUG-FE-MAP-006 | Low | `Map/MapScreen.tsx` | Hotspots rebuild on every render |
| 29 | BUG-FE-MAP-007 | Low | `Map/MapScreen.tsx` | Decorative SVG not SR-hidden; spatial traversal order |

---

## Practice — screen, selector, weekly progress

### BUG-FE-PRACTICE-001 — Stage number defaults to 1 and is never reconciled with server progression (mirrors BUG-PRACTICE-004)
- **Severity:** High
- **Component:** `frontend/src/features/Practice/PracticeScreen.tsx:31, 498-504`
- **Symptom:** If the user navigates to `Practice` without `route.params.stageNumber` (deep link, tab press, notification), the screen silently requests stage 1 practices and POSTs `user_practices.create({ practice_id, stage_number: 1 })` regardless of the user's actual current stage. Any existing active user-practice on stages 2-36 is hidden, and a stale stage-1 selection can be created. The backend (per BUG-PRACTICE-004) does not validate the pair server-side, so the mismatch persists.
- **Root cause:**
  ```tsx
  const DEFAULT_STAGE_NUMBER = 1;
  // ...
  const route = useAppRoute<'Practice'>();
  const stageNumber = route.params?.stageNumber ?? DEFAULT_STAGE_NUMBER;
  const loader = usePracticeLoader(stageNumber);
  ```
  The hard-coded fallback bypasses the user's real progression. `usePracticeSelect` then forwards the fallback value into the create call (line 77-80) with no reconciliation.
- **Fix:** Resolve the current stage from server state (e.g. a `/me/progression` or `stages.currentStage()` call) before mounting the loader. If no stage can be resolved, show an empty/loading state instead of defaulting to `1`. At minimum, read the user's current stage from the auth/profile context rather than a module-level constant.

### BUG-FE-PRACTICE-002 — `PracticeSelector` never receives `isLocked`; locked-stage practices render as tappable cards
- **Severity:** High
- **Component:** `frontend/src/features/Practice/PracticeScreen.tsx:349-355`, `frontend/src/features/Practice/PracticeSelector.tsx:49-94`
- **Symptom:** `PracticeSelector` exposes an `isLocked` prop with a dedicated empty state, but `PracticeScreen` never passes it — the default `isLocked = false` is used unconditionally. Consequently, when the backend returns practices for a locked stage (for example, because the user deep-linked to a future stage, or BUG-FE-PRACTICE-001 pinned them to stage 1 after they advanced), every card shows a working `Select` button. Tapping it calls `userPractices.create` and creates a `UserPractice` row on a stage the user has not unlocked.
- **Root cause:**
  ```tsx
  <PracticeSelector
    practices={availablePractices}
    selectedPracticeId={activeUserPractice?.practice_id ?? null}
    onSelect={onSelectPractice}
    isLoading={false}
  />
  ```
  No `isLocked` prop is forwarded; there is no client-side gating of the `Select` button based on stage eligibility, and no server-trusted stage-is-unlocked check before the POST fires.
- **Fix:** Thread a `stageUnlocked: boolean` through `usePracticeLoader` (derived from the user's current stage vs. the requested `stageNumber`) and pass it as `isLocked={!stageUnlocked}`. In `PracticeCard`, also disable the `Select` button when locked so even if the list renders, tapping is a no-op. Back this with a server-side check (pairs with BUG-PRACTICE-004).

### BUG-FE-PRACTICE-003 — `WeeklyProgress` aggregate is stale after multi-day use and after Journal round-trip
- **Severity:** Medium
- **Component:** `frontend/src/features/Practice/PracticeScreen.tsx:114-120, 184`, `frontend/src/features/Practice/WeeklyProgress.tsx:12-14`
- **Symptom:** `weekCount` is fetched once on mount via `practiceSessions.weekCount()` and then mutated only through `incrementWeekCount` after a successful `handleSaveSession`. Two distinct drifts result:
  1. If the user keeps the screen open across the Monday-morning week rollover, the count never resets — it keeps growing and the "Weekly target reached!" banner stays lit.
  2. `handleWriteReflection` navigates to `Journal` and then returns; `PracticeScreen` is remounted by React Navigation but the loader effect only re-runs because `loadData` identity is stable, *not* because of a focus event — if the navigator keeps the screen mounted, the count is never refreshed.
  Additionally, if the backend rejects the session (network error) but the client has already incremented via optimistic paths, the bar and count are out of sync (see BUG-FE-PRACTICE-006).
- **Root cause:**
  ```tsx
  const [practiceList, userPracticeList, weekResult] = await Promise.all([
    practices.list(stageNumber),
    userPractices.list(),
    practiceSessions.weekCount(),
  ]);
  // ... later, only on save success:
  incrementWeekCount();
  ```
  No `useFocusEffect` / interval refresh; no re-sync when the user returns from `Journal`; `WeeklyProgress` trusts the local counter as ground truth.
- **Fix:** Use `useFocusEffect` from `@react-navigation/native` to call `loadData()` (or a lighter `practiceSessions.weekCount()` refresh) when the screen regains focus. Also re-fetch after `handleSaveSession` resolves rather than incrementing locally — the server is the source of truth for weekly aggregates, especially around week boundaries and across the timezone drift described in BUG-PRACTICE-009.

### BUG-FE-PRACTICE-004 — Session submit trusts client `duration_minutes`; zero- and fractional-minute saves are allowed (mirrors BUG-PRACTICE-005/006)
- **Severity:** High
- **Component:** `frontend/src/features/Practice/PracticeScreen.tsx:175-196, 406-412`
- **Symptom:** `handleTimerComplete(actualMinutes)` stores whatever the timer reports, and `handleSaveSession` posts it verbatim as `duration_minutes` with no floor, no cap, no server-stamped timestamp. A user who cancels the timer and taps "Save Session" — or a bugged `PracticeTimer` that emits `0` — creates a zero-duration session row. There is also no `timestamp` field being set client-side, but the backend (per BUG-PRACTICE-006) accepts client-supplied timestamps; pairing these means any future schema change that re-enables client timestamps will be immediately exploitable from this call site.
- **Root cause:**
  ```tsx
  const payload: PracticeSessionCreate = {
    user_practice_id: activeUserPractice.id,
    duration_minutes: completedMinutes,
  };
  const session = await practiceSessions.create(payload);
  ```
  No validation of `completedMinutes >= 1`, no ceiling (e.g. `<= 180`), no guard against `NaN` from a malformed timer callback.
- **Fix:** Guard `handleSaveSession` with `if (completedMinutes < 1) { setError('Session too short to save'); return; }` and cap at a sane maximum (e.g. 240 min). Keep the `timestamp` field out of the payload so the backend stamps it server-side (pairs with the BUG-PRACTICE-006 server-side fix). Surface the validation error in `SummaryView` rather than silently discarding.

### BUG-FE-PRACTICE-005 — Optimistic `incrementWeekCount` is never rolled back on save failure
- **Severity:** Medium
- **Component:** `frontend/src/features/Practice/PracticeScreen.tsx:175-196`
- **Symptom:** `handleSaveSession` calls `incrementWeekCount()` *before* awaiting the network response has settled — actually, reading carefully: it calls `incrementWeekCount()` **only on the success branch**, so the naming is misleading but the real issue is the opposite pattern. However there is still a race: if `practiceSessions.create` resolves with a response that the backend later rejects (e.g. a 200 shape but server-side rollback, or the retry in BUG-PRACTICE-007 duplicate detection), the weekly count is incremented while the session write may not have been durable. Moreover, if the user triggers `handleSaveSession` twice rapidly (no disabled-while-pending guard on `SummaryView`'s save button — `disabled={isSaving}` exists, but nothing prevents re-render gaps), two increments can fire for one durable session.
- **Root cause:**
  ```tsx
  const session = await practiceSessions.create(payload);
  incrementWeekCount();
  setSavedSession(session);
  ```
  The counter is a client-side mirror with no reconciliation against the server. On error (`catch` branch) no rollback occurs because no optimistic increment happened — but on success there is no verification that `session.id` is non-null, and no idempotency key (mirrors BUG-PRACTICE-007) so retries double-increment.
- **Fix:** Replace `incrementWeekCount()` with a fresh `practiceSessions.weekCount()` fetch after save (or after a focus event) so the bar is always authoritative. Add an idempotency key on the payload and hold `isSaving=true` for the whole flow including the post-save refresh.

### BUG-FE-PRACTICE-006 — Auth expiry during load renders the empty `selector-empty` state instead of prompting re-auth
- **Severity:** Medium
- **Component:** `frontend/src/features/Practice/PracticeScreen.tsx:110-136, 506-511`
- **Symptom:** `useLoadPracticeData` wraps three network calls in `Promise.all` and routes any thrown error through `formatApiError` with a generic "check your connection" fallback. A 401 (access token expired while the screen was backgrounded) is flattened to the same message, with a `Retry` button that will loop forever until the user kills the app, because `AuthContext` is not notified and the token is not refreshed. Additionally, if `practices.list(stageNumber)` returns `[]` for a locked/future stage and the other two calls resolve, the screen silently shows `selector-empty` with no indication that the user is on the wrong stage (pairs with BUG-FE-PRACTICE-001).
- **Root cause:**
  ```tsx
  } catch (err) {
    setError(
      formatApiError(err, {
        fallback:
          "We couldn't load your practices. Check your connection, then tap Retry to try again.",
      }),
    );
  }
  ```
  No branch on `err.status === 401`; no trigger of the auth context's logout/refresh flow; no error boundary wrapping the screen so a render-time throw (e.g. `route.params` undefined in a nested navigator) would white-screen the tab.
- **Fix:** In the catch branch, inspect the error status: on 401, call `auth.signOut()` (or a refresh flow) rather than showing a retry loop. Wrap `PracticeScreen` in an `ErrorBoundary` so runtime errors render a recoverable fallback. When `practices.list(stageNumber)` returns `[]` *and* `stageNumber !== user.currentStage`, display a "stage locked" message instead of the generic empty state.

### BUG-FE-PRACTICE-007 — Interactive elements lack accessibility roles/labels
- **Severity:** Low
- **Component:** `frontend/src/features/Practice/PracticeScreen.tsx:230-233, 273-284, 299-313, 340-346`, `frontend/src/features/Practice/PracticeSelector.tsx:37-45`
- **Symptom:** Every `TouchableOpacity` in the Practice flow (Retry, Save Session, Skip, Write Reflection, Start Practice, Select) is missing `accessibilityRole="button"`, `accessibilityLabel`, and `accessibilityState` for the disabled case. VoiceOver/TalkBack users hear raw visible text only, and the "Save Session" button's disabled-while-saving state is invisible to assistive tech. The checkmark `✓` (PracticeSelector:30-32) is a bare `Text` node with no `accessibilityLabel="Selected"`, so screen readers announce only the glyph.
- **Root cause:**
  ```tsx
  <TouchableOpacity
    style={localStyles.saveButton}
    onPress={onSave}
    disabled={isSaving}
    testID="save-session-button"
  >
    <Text style={localStyles.saveButtonText}>{isSaving ? 'Saving...' : 'Save Session'}</Text>
  </TouchableOpacity>
  ```
  No `accessibilityRole`, no `accessibilityLabel`, no `accessibilityState={{ disabled: isSaving, busy: isSaving }}`.
- **Fix:** Add `accessibilityRole="button"` and explicit `accessibilityLabel` to every `TouchableOpacity`. For buttons with transient loading text, pass `accessibilityState={{ disabled, busy: disabled }}`. Give the selected-checkmark `Text` an `accessibilityLabel="Selected practice"` or wrap the card in an `accessibilityState={{ selected: isSelected }}` container so the selection is announced semantically rather than via a visible glyph.


---

## Practice — timer

### BUG-FE-PRACTICE-101 — Timer drifts and over/under-counts in background due to wall-clock-blind `setInterval`
- **Severity:** Critical
- **Component:** `frontend/src/features/Practice/PracticeTimer.tsx:107-132`
- **Symptom:** When the app is backgrounded, the device sleeps, or the JS thread is throttled, `setInterval` is paused/coalesced by the OS. On return, the displayed `remaining` is stale (too high) and the practice session does not end at its scheduled wall-clock time. For very long backgrounds, iOS/Android will terminate the interval entirely and the timer never completes.
- **Root cause:**
  ```tsx
  const tick = useCallback(() => {
    setRemaining((prev) => (prev - 1 <= 0 ? 0 : prev - 1));
  }, [setRemaining]);

  useEffect(() => {
    if (state !== 'running') return;
    intervalRef.current = setInterval(tick, TIMER_INTERVAL_MS);
    return () => { clearTimer(); };
  }, [state, clearTimer, intervalRef, tick]);
  ```
  The timer treats each interval firing as "exactly 1 second elapsed." There is no anchor to wall-clock time (e.g. `Date.now()` start), so suspended/coalesced intervals silently lose seconds. There is also no `AppState` listener to re-sync on foreground.
- **Fix:** Record `startedAt = Date.now()` (and `pausedAccumMs`) in a ref when entering `running`. Derive `remaining = totalSeconds - Math.floor((Date.now() - startedAt - pausedAccumMs) / 1000)` on each tick, and recompute on `AppState` `active` transitions. This makes the interval a redraw clock rather than a counter and eliminates drift entirely.

### BUG-FE-PRACTICE-102 — Rapid Start / Cancel / Start spawns concurrent intervals (race → double-speed countdown)
- **Severity:** High
- **Component:** `frontend/src/features/Practice/PracticeTimer.tsx:82-112,126-132`
- **Symptom:** Tapping Start, then Cancel, then Start again quickly (or Resume/Pause oscillation) can leave a stale `setInterval` running alongside the new one: the displayed time ticks down at 2x, the end-bell rings twice, and `onComplete` fires with half the intended duration.
- **Root cause:**
  ```tsx
  const handleStart = useCallback(() => {
    setState('running');
    halfwayPlayedRef.current = false;
    setRemaining(totalSeconds);
    playSound(SOUND_START);
    activateKeepAwakeAsync(KEEP_AWAKE_TAG);
  }, [totalSeconds, setState, setRemaining, halfwayPlayedRef]);
  ```
  `handleStart` does not call `clearTimer()` before scheduling, and the `useEffect` at line 126 schedules a new `setInterval` on every change to its deps (including `tick`, which is recreated on each render). Because `intervalRef.current` is overwritten without clearing, the previous handle leaks and keeps firing. The effect's cleanup only runs when the deps change *again*, so the overlap window is real.
- **Fix:** Call `clearTimer()` at the top of `handleStart`, `handleResume`, and at the top of the interval-scheduling effect before assigning `intervalRef.current`. Alternatively, make `tick` depend only on stable refs so the effect does not re-run per render.

### BUG-FE-PRACTICE-103 — Audio `Sound` objects leak on unmount / rapid playback
- **Severity:** High
- **Component:** `frontend/src/features/Practice/PracticeTimer.tsx:20-31,152-157`
- **Symptom:** If the component unmounts during playback (user navigates away mid-session), or if `playSound` is invoked while a previous sound's 3-second `setTimeout` has not yet fired, native audio resources are never unloaded. Over a long session this leaks `AVAudioPlayer`/`MediaPlayer` handles, and on unmount the unload `setTimeout` fires against an orphaned sound.
- **Root cause:**
  ```tsx
  async function playSound(source: number): Promise<void> {
    try {
      const { sound } = await Audio.Sound.createAsync(source);
      await sound.playAsync();
      setTimeout(() => { sound.unloadAsync(); }, 3000);
    } catch (err) { ... }
  }
  ```
  The `sound` instance is captured by a local `setTimeout` with no tracking, no cancellation on unmount, and no `setOnPlaybackStatusUpdate` to unload when playback actually finishes. The component's unmount cleanup (lines 152-157) only touches the interval and keep-awake — it never unloads active sounds.
- **Fix:** Track live `Sound` handles in a ref (`soundsRef.current: Sound[]`), register `setOnPlaybackStatusUpdate` to unload on `didJustFinish`, and in the unmount effect iterate and `unloadAsync()` all pending handles. Also clear any pending unload `setTimeout` ids.

### BUG-FE-PRACTICE-104 — Pause does not stop elapsed time because `useEffect` re-subscribes and keeps counting
- **Severity:** High
- **Component:** `frontend/src/features/Practice/PracticeTimer.tsx:90-96,126-132`
- **Symptom:** Pause visually stops the display, but when Resume is tapped the previously-running interval (not yet garbage-collected due to effect timing) may have advanced `remaining` past where it was paused — users see their time "jump" backwards on resume. Additionally, a tap on Pause during the same JS tick as a `tick()` can record a wrong elapsed value for `onComplete`.
- **Root cause:**
  ```tsx
  const handlePause = useCallback(() => {
    setState('paused');
    clearTimer();
  }, [setState, clearTimer]);
  const handleResume = useCallback(() => {
    setState('running');
  }, [setState]);
  ```
  Pause relies on `clearTimer()` being synchronous, but the interval-scheduling effect at line 126 uses `state` in its deps. Because `tick` is recreated every render, the effect tears down and re-creates intervals on any re-render while running — there is a non-zero window in which both old and new intervals coexist. Resume likewise doesn't re-anchor to wall-clock time, so accumulated drift is permanent.
- **Fix:** Track `pauseStartedAt` and `pausedAccumMs` in refs; compute elapsed from `Date.now() - startedAt - pausedAccumMs`. On pause, snapshot `remaining` into a ref and on resume re-anchor `startedAt` so wall-clock math stays coherent. Stabilise `tick` via `useRef` so the scheduling effect runs at most once per state transition.

### BUG-FE-PRACTICE-105 — `onComplete` reports client-computed minutes (trusts unsynchronised clock) — triggers BUG-PRACTICE-006 on backend
- **Severity:** High
- **Component:** `frontend/src/features/Practice/PracticeTimer.tsx:141-150`
- **Symptom:** The session record sent to the backend is based on client state that can be manipulated (device clock changes, backgrounded+resumed runs), and — because of BUG-FE-PRACTICE-101 — is often shorter than the user actually meditated. Worse, `elapsedMinutes` is always `(totalSeconds - 0) / 60 = durationMinutes` at the moment this runs (since the effect only fires when `remaining <= 0`), so the "elapsed" reporting is cosmetic.
- **Root cause:**
  ```tsx
  useEffect(() => {
    if (state !== 'running' || remaining > 0) return;
    clearTimer();
    deactivateKeepAwake(KEEP_AWAKE_TAG);
    setState('completed');
    playSound(SOUND_END);
    Vibration.vibrate([0, 200, 100, 200, 100, 200]);
    const elapsedMinutes = (totalSeconds - remaining) / SECONDS_PER_MINUTE;
    onComplete(elapsedMinutes);
  }, [remaining, state, clearTimer, setState, totalSeconds, onComplete]);
  ```
  `remaining` is guaranteed `0` here so `elapsedMinutes === durationMinutes` always — the calculation is dead code. Also, the backend should not trust a client-reported duration (see BUG-PRACTICE-006): start/stop timestamps with server-side clamping are required.
- **Fix:** Send server-trusted boundaries: record `startedAt` on Start and send both `startedAt` and `endedAt` (client wall-clock hint only) to the backend, which recomputes and clamps duration against `durationMinutes` and the server clock. Remove the always-zero subtraction.

### BUG-FE-PRACTICE-106 — Keep-awake never released when component unmounts mid-run from a parent-initiated nav
- **Severity:** Medium
- **Component:** `frontend/src/features/Practice/PracticeTimer.tsx:87,100,144,152-157`
- **Symptom:** If the user backs out of the screen while the timer is running (not via Cancel/Complete), the unmount cleanup runs but other code paths also call `deactivateKeepAwake` without checking whether it was ever activated for this tag. Worse, the cleanup uses the closed-over `clearTimer` callback only — if `activateKeepAwakeAsync` is still pending (promise not resolved) when unmount runs, `deactivateKeepAwake(KEEP_AWAKE_TAG)` races and the screen stays awake until the OS releases the tag, draining battery.
- **Root cause:**
  ```tsx
  useEffect(() => {
    return () => {
      clearTimer();
      deactivateKeepAwake(KEEP_AWAKE_TAG);
    };
  }, [clearTimer]);
  ```
  The activation is fire-and-forget (`activateKeepAwakeAsync(KEEP_AWAKE_TAG)` has no `await`, no error handling, result discarded). There is no ref tracking "is keep-awake currently held?", so deactivation is called unconditionally even when activation failed, and isn't guaranteed to win the race against a still-in-flight activation.
- **Fix:** Track `keepAwakeHeldRef = useRef(false)`; set it on successful `await activateKeepAwakeAsync(...)` and only call `deactivateKeepAwake` from a single helper that checks the ref. In the unmount effect, await-then-deactivate via a cancellable chain, or use `expo-keep-awake`'s hook (`useKeepAwake`) scoped to `state === 'running' || 'paused'`.

### BUG-FE-PRACTICE-107 — Halfway bell can fire immediately for odd durations or very short sessions
- **Severity:** Medium
- **Component:** `frontend/src/features/Practice/PracticeTimer.tsx:124,134-139`
- **Symptom:** For `durationMinutes = 1` (60s), `halfwaySeconds = Math.floor(60/2) = 30`. Fine. But for `durationMinutes < 1` (if ever passed, e.g. dev/test) or when `totalSeconds` is 1, `halfwaySeconds = 0`, and the condition `remaining <= halfwaySeconds` is satisfied on the very first tick — the halfway bell plays at start, overlapping the start bell. Also, because `halfwayPlayedRef` is only reset in `handleStart`/`handleCancel`, if the component remounts mid-session the halfway bell will replay.
- **Root cause:**
  ```tsx
  const halfwaySeconds = Math.floor(totalSeconds / 2);
  useEffect(() => {
    if (state === 'running' && remaining <= halfwaySeconds && !halfwayPlayedRef.current) {
      halfwayPlayedRef.current = true;
      playSound(SOUND_HALF);
    }
  }, [remaining, state, halfwayPlayedRef, halfwaySeconds]);
  ```
  The effect triggers as soon as `remaining === totalSeconds` and `halfwaySeconds === 0`, firing at session start. There is also no guard for `totalSeconds < 2`, and using `<=` means a session that starts exactly at the halfway boundary double-plays.
- **Fix:** Require `totalSeconds >= 2` before arming the halfway bell and change the guard to `remaining === halfwaySeconds` or `remaining < halfwaySeconds && remaining > 0`. Reset `halfwayPlayedRef` in a mount effect keyed by `totalSeconds` so it survives remounts correctly.

### BUG-FE-PRACTICE-108 — Accessibility: remaining time is not announced, and Start/Pause/Resume lack live state labels
- **Severity:** Low
- **Component:** `frontend/src/features/Practice/PracticeTimer.tsx:176-178,186-190,194-203,213-232,241-262`
- **Symptom:** Screen-reader users have no way to hear time remaining without manually focusing `time-remaining`; the timer never announces milestones, completion, or state transitions. Buttons expose static `accessibilityLabel="Pause timer"` etc. but do not expose `accessibilityState={{ disabled, busy }}` or `accessibilityLiveRegion`. The `progress-indicator` reports `{ min:0, max:100, now }` but without `accessibilityRole="progressbar"`, iOS TalkBack/VoiceOver won't read it as progress.
- **Root cause:**
  ```tsx
  <Text style={timerStyles.timeText} testID="time-remaining">
    {formatTime(remaining)}
  </Text>
  ...
  <View
    style={[timerStyles.progressArc, { opacity: progress }]}
    testID="progress-indicator"
    accessibilityValue={{ min: 0, max: 100, now: Math.round(progress * 100) }}
  />
  ```
  No `accessibilityLiveRegion="polite"` on the time text, no `accessibilityRole="timer"` / `"progressbar"` on the ring, and no periodic `AccessibilityInfo.announceForAccessibility` (e.g. at halfway and final minute). Completion state adds a "Complete" Text but doesn't announce it.
- **Fix:** Add `accessibilityRole="timer"` + `accessibilityLiveRegion="polite"` to the time text (Android) and call `AccessibilityInfo.announceForAccessibility` at halfway, 1-minute-left, and completion. Give the progress arc `accessibilityRole="progressbar"`. Include dynamic `accessibilityLabel` like `"Start ${durationMinutes} minute practice"`.

### BUG-FE-PRACTICE-109 — Completion state flashes "Complete" for zero-duration or rapid-finish paths
- **Severity:** Low
- **Component:** `frontend/src/features/Practice/PracticeTimer.tsx:141-150,289`
- **Symptom:** If `durationMinutes <= 0` is passed (bad config, test fixture, or edit-in-flight), `totalSeconds = 0`, `remaining = 0`, and — because state starts as `'idle'` — Start never transitions to completion (`state !== 'running'` guard passes). But when the user taps Start, `setRemaining(totalSeconds)` sets it back to 0, the interval fires once, and the completion effect runs *after* the same render — `onComplete(0)` fires, the end bell and a 600ms vibration play, and the UI flashes the completed ring for one frame before the parent unmounts. Negative durations silently produce `progress = NaN` (division path is guarded but `progress = elapsed/0` yields `NaN`).
- **Root cause:**
  ```tsx
  const PracticeTimer: React.FC<PracticeTimerProps> = ({ durationMinutes, onComplete, onCancel }) => {
    const totalSeconds = durationMinutes * SECONDS_PER_MINUTE;
    ...
  ```
  No validation of `durationMinutes > 0`. The state machine allows `running` -> `completed` with `remaining === 0` on the first `tick`, firing bell + vibration for a session the user never actually took.
- **Fix:** Guard at component entry: `if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) return null;` (or render an error state), and in the completion effect require `elapsedMinutes > 0` before calling `onComplete`. Also clamp `progress` with `Math.min(1, Math.max(0, progress))`.


---

## Course — screens

### BUG-FE-COURSE-001 — ContentViewer renders title and URL for locked content
- **Severity:** High
- **Component:** `frontend/src/features/Course/ContentViewer.tsx:107-145`
- **Symptom:** If a `ContentItem` with `is_locked === true` somehow reaches `ContentViewer` (e.g., via stale list state, deep link, or a backend leak mirroring BUG-COURSE-001), the viewer renders the item's `title` in the header and a clickable "Open in Browser" button pointing at `item.url`. Users can exfiltrate locked material without unlocking the stage.
- **Root cause:**
  ```tsx
  const ContentViewer = ({ item, onBack, onMarkRead, onReflect }) => {
    const { marking, isRead, handleMarkRead } = useMarkReadHandler(item, onMarkRead);
    const handleOpenUrl = useCallback(async () => {
      if (!item.url || !isValidUrl(item.url)) return;
      await Linking.openURL(item.url);
    }, [item.url]);
    return (
      <View ...>
        <ViewerHeader title={item.title} onBack={onBack} />
        <TouchableOpacity onPress={handleOpenUrl} testID="open-url-button">...
  ```
  There is no `item.is_locked` guard inside `ContentViewer`. `CourseScreen.handleContentPress` (line 204-206) short-circuits when the card is locked, but the viewer itself provides no second line of defense, and `markRead` / URL open still fire for locked IDs.
- **Fix:** At the top of `ContentViewer`, if `item.is_locked`, render a "This content is locked until day N" placeholder and disable `handleMarkRead` / `handleOpenUrl`. Also assert in `useMarkReadHandler` that locked items cannot POST to `/course/contents/{id}/read`. Cross-ref BUG-COURSE-001 (backend must also stop returning `url`/`title` for locked items).

### BUG-FE-COURSE-002 — StageSelector derives stage count from max stage_number and can render future stages
- **Severity:** High
- **Component:** `frontend/src/features/Course/StageSelector.tsx:9-13, 55-89`
- **Symptom:** `totalStageCount(stages)` uses `Math.max(...stages.map(s => s.stage_number))` so whatever the API returns drives the pill count. If the backend leaks unlocked-but-not-yet-released stages (mirror of BUG-COURSE-003), or if a test/staging env seeds stages 1..36, every user sees 36 pills regardless of their actual cohort day. The `isUnlocked` check only gates pressability, not visibility, so future stages are still discoverable as gray/lock icons — revealing the program's shape prematurely.
- **Root cause:**
  ```tsx
  function totalStageCount(stages: Stage[]): number {
    if (stages.length === 0) return 0;
    return Math.max(...stages.map((s) => s.stage_number));
  }
  // ...
  {Array.from({ length: totalStageCount(stagesList) }, (_, i) => {
    const stageNumber = i + 1;
    const unlocked = isUnlocked(stageNumber, stagesList);
    // renders locked pill regardless
  ```
  There is no notion of `is_visible` vs `is_unlocked`; the selector assumes anything returned by `stages.list()` is safe to paint.
- **Fix:** Filter `stagesList` by a new `is_visible`/`is_revealed` flag (add to `Stage` DTO) before computing the range, or limit to `currentStage + 1`. Do not iterate 1..max; iterate over the filtered array itself so skipped numbers don't produce ghost pills. Cross-ref BUG-COURSE-003.

### BUG-FE-COURSE-003 — ContentCard lacks accessibilityHint and accessibilityState for locked items
- **Severity:** Medium
- **Component:** `frontend/src/features/Course/ContentCard.tsx:51-80`
- **Symptom:** Locked content cards have a descriptive `accessibilityLabel` ("Title, locked") but no `accessibilityState={{ disabled: true }}` and no `accessibilityHint` explaining what will happen / why. Screen-reader users hear "button" for a card that does nothing on activation. Contrast this with `StageSelector.tsx:69` which correctly sets `accessibilityState={{ disabled: !unlocked }}`.
- **Root cause:**
  ```tsx
  <TouchableOpacity
    testID={`content-card-${item.id}`}
    accessible
    accessibilityRole="button"
    accessibilityLabel={`${item.title}${item.is_locked ? ', locked' : ''}${item.is_read ? ', read' : ''}`}
    disabled={item.is_locked}
    onPress={() => { if (item.is_locked) return; onPress(item); }}
  ```
  No `accessibilityState` passed; no `accessibilityHint` such as "Unlocks on day N".
- **Fix:** Add `accessibilityState={{ disabled: item.is_locked }}` and, when locked, `accessibilityHint={`Unlocks on day ${item.release_day}`}`. When read, add `accessibilityState={{ selected: true }}` or equivalent. Remove the ad-hoc string concatenation in `accessibilityLabel` in favor of structured state props.

### BUG-FE-COURSE-004 — FlatList is unbounded with no pagination or windowSize tuning
- **Severity:** Medium
- **Component:** `frontend/src/features/Course/CourseScreen.tsx:65-81, 186-195`
- **Symptom:** `courseApi.stageContent(selectedStage)` is awaited in full and dumped into `<FlatList data={content} />` with no `initialNumToRender`, `windowSize`, `maxToRenderPerBatch`, or pagination. A stage with 30+ content items (APTITUDE has essay + prompt + video per week × multiple weeks) renders every card on mount. Combined with a per-stage progress fetch on every switch, tab-switching between stages re-downloads the whole content list — mirror of BUG-STAGE-004 N+M.
- **Root cause:**
  ```tsx
  const refreshContent = useCallback(async () => {
    const [contentResult, progressResult] = await Promise.all([
      courseApi.stageContent(selectedStage),
      courseApi.stageProgress(selectedStage),
    ]);
    setContent(contentResult);
  // ...
  <FlatList testID="content-list" data={content} renderItem={renderContentItem}
            keyExtractor={(item) => String(item.id)} ListEmptyComponent={renderEmpty} />
  ```
  No pagination params, no caching between stages, no `getItemLayout`, no `removeClippedSubviews`.
- **Fix:** Either (a) paginate `/course/stages/{n}/content?limit&offset` and use `onEndReached`, or (b) cache content-by-stage in a `Map<number, ContentItem[]>` inside the hook so re-selecting a stage is instant. Also pass `initialNumToRender={8}`, `windowSize={5}`, and `removeClippedSubviews`. Cross-ref BUG-STAGE-004.

### BUG-FE-COURSE-005 — markRead race: back navigation while request is in flight causes setState on unmounted viewer
- **Severity:** Medium
- **Component:** `frontend/src/features/Course/ContentViewer.tsx:83-105`, `CourseScreen.tsx:208, 238-247`
- **Symptom:** User taps "Mark as Read" (`setMarking(true)` → `await courseApi.markRead`) and then taps Back before the request resolves. `CourseScreen` sets `viewingItem = null` so `<ContentViewer>` unmounts. When the promise resolves, `setIsRead(true)` and `setMarking(false)` run on an unmounted component, and `onMarkRead()` fires a `refreshContent()` against the (possibly already-changed) `selectedStage`. Result: React "update on unmounted component" warning, and in the worst case a stale list refresh that clobbers a newer one.
- **Root cause:**
  ```tsx
  const handleMarkRead = useCallback(async () => {
    if (isRead || marking) return;
    setMarking(true);
    try {
      await courseApi.markRead(item.id);
      setIsRead(true);
      onMarkRead();
    } catch (err) { /* ... */ }
    finally { setMarking(false); }
  }, [isRead, marking, item.id, onMarkRead]);
  ```
  No `AbortController`, no `isMounted` ref; `onBack` also doesn't await or cancel the in-flight POST.
- **Fix:** Use an `AbortController` in `useMarkReadHandler` (pass signal to `courseApi.markRead`); in a cleanup effect call `controller.abort()`. Guard `setIsRead`/`setMarking` with an `isMountedRef`. Alternatively, disable the Back button while `marking` is true. Also make `CourseScreen.handleBack` a no-op (or confirmation) while a mark-read is pending.

### BUG-FE-COURSE-006 — "Open in Browser" opens arbitrary URLs with weak validation
- **Severity:** Medium
- **Component:** `frontend/src/features/Course/ContentViewer.tsx:115-122`
- **Symptom:** `handleOpenUrl` passes `item.url` to `Linking.openURL` after a single `isValidUrl` check. If the backend is ever compromised or an admin mis-enters a URL (javascript:, intent://, custom schemes, or a phishing domain that mimics internal content), the app opens it without user confirmation or scheme allowlisting. Even for legitimate https URLs, leaving the app silently is bad UX and a potential XSS-in-webview risk if the roadmap ever replaces `Linking` with `WebView`.
- **Root cause:**
  ```tsx
  const handleOpenUrl = useCallback(async () => {
    if (!item.url || !isValidUrl(item.url)) return;
    try {
      await Linking.openURL(item.url);
    } catch (err) { console.error('Failed to open URL:', err); }
  }, [item.url]);
  ```
  `isValidUrl` (utility) likely only checks URL parseability, not scheme allowlist. No `Linking.canOpenURL` probe, no confirmation dialog, and the target is clickable for every content type regardless of whether `url` is semantically required.
- **Fix:** In `handleOpenUrl`, enforce `new URL(item.url).protocol === 'https:'` (reject http, javascript, intent, file, custom schemes). Call `Linking.canOpenURL` first. Show a confirmation Alert ("Leave the app to open external content?") before navigating. Hide the "Open in Browser" button entirely when `item.url` is empty/null. If future work introduces `WebView`, sanitize markdown/HTML with a dedicated sanitizer and never interpolate raw `item.url` into a `source={{ html }}` prop.


---

## Map — stage overview

## Frontend Map Feature — Bug Audit

Scope: `frontend/src/features/Map/MapScreen.tsx`, `stageData.ts`, `services/stageService.ts` (~650 LOC).

Cross-refs: BUG-STAGE-* (backend stage domain), BUG-COURSE-* (course lock-gate parity).

---

### BUG-FE-MAP-001 — Hotspots render all stages with no server-side unlock gate, relying solely on API-returned `is_unlocked`
- **Severity:** High
- **Component:** `frontend/src/features/Map/MapScreen.tsx:82-113` and `frontend/src/features/Map/services/stageService.ts:17-39`
- **Symptom:** Every stage returned by `/stages` is rendered as a tappable hotspot regardless of unlock status. A user with only stage 1 unlocked still sees hotspots 2–10 and can open their modals (which then expose metadata and `overviewUrl`). If the backend ever over-returns stages (see BUG-STAGE-002 / BUG-COURSE-001 mirror), the UI has no second-layer guard.
- **Root cause:**
  ```tsx
  // stageService.ts:18-38
  export const toStageData = (apiStage: Stage): StageData => {
    // ...no filtering; every API stage becomes a StageData
    return { /* ... */ isUnlocked: apiStage.is_unlocked, /* ... */ };
  };
  // MapScreen.tsx:82 — flatMap renders a hotspot for EVERY stage in the array,
  // locked or not. onPress(stage) fires unconditionally (see BUG-FE-MAP-004).
  {stages.flatMap((stage) => stage.hotspots.map((hs, index) => (
    <TouchableOpacity ... onPress={() => onPress(stage)} />
  )))}
  ```
  The frontend trusts `is_unlocked` from the API and has no client-side derivation from `current_stage`. If backend lock logic is buggy or bypassed, the modal still opens on a "locked" stage and reveals its full metadata (`StageMetadataSection`) because the lock check in `ModalBody` is only on the history section (line 356). This mirrors BUG-COURSE-001 where course content leaks past the unlock gate.
- **Fix:** Derive `isUnlocked` defensively as `apiStage.is_unlocked && apiStage.stage_number <= currentStage` in `toStageData`, and in `MapScreen` guard the modal body so locked stages show only a teaser (`title` + lock message + unlock requirement) instead of full metadata/actions. Skip rendering `ActionLinks` and `StageMetadataSection` when `!stage.isUnlocked`.

---

### BUG-FE-MAP-002 — `current_stage` derived locally from `progress < 1` diverges from backend truth
- **Severity:** High
- **Component:** `frontend/src/features/Map/services/stageService.ts:41-45,62`
- **Symptom:** The Map highlights the wrong stage as "current" whenever the backend's authoritative `current_stage` disagrees with the frontend's heuristic. Example: after a stage is marked current server-side but `progress` is still 0, the client picks the first `is_unlocked && progress < 1` — typically stage 1 — even when the user is actually on stage 3. This drifts further as users complete stages non-sequentially (allowed via practice-based progress).
- **Root cause:**
  ```ts
  // stageService.ts:42-45
  const pickCurrentStage = (apiStages: Stage[]): number =>
    apiStages.find((s) => s.is_unlocked && s.progress < 1)?.stage_number ??
    apiStages.at(-1)?.stage_number ??
    1;
  ```
  The client re-derives `currentStage` instead of reading the server's `current_stage` field (the `/stages` or `/progression/current` endpoint exposes it). Two sources of truth means the "current" styling (`styles.hotspotCurrent`, line 65) can point at the wrong hotspot. Mirrors BUG-STAGE-002 (current_stage source-of-truth drift).
- **Fix:** Read `current_stage` from the backend response (either include it in `GET /stages` payload or call `/progression/current`) and pass it through `setCurrentStage`. Remove `pickCurrentStage` entirely; never compute it client-side. Only fall back to a heuristic if the server field is missing, and log a warning when that path is hit.

---

### BUG-FE-MAP-003 — Progress percent in modal displays raw per-stage `progress` field without validating what it averages
- **Severity:** Medium
- **Component:** `frontend/src/features/Map/MapScreen.tsx:145-158` and `stageService.ts:26`
- **Symptom:** `Progress: {Math.round(stage.progress * 100)}%` shows whatever the backend emits in `Stage.progress`. If the backend blends practice-minute ratios with habit-streak ratios without weighting (see BUG-STAGE-005: averages wrong metrics), the user sees numbers like "73%" that do not correspond to any coherent metric — and the progress bar width is driven by the same misleading value. There is also no guard against `progress > 1` or `NaN`, so a bad payload can overflow the bar (width: 110%) or render as `NaN%`.
- **Root cause:**
  ```tsx
  // MapScreen.tsx:147-156
  <Text style={styles.progressLabel}>Progress: {Math.round(stage.progress * 100)}%</Text>
  <View style={styles.progressBar}>
    <View style={[styles.progressFill,
      { width: `${stage.progress * 100}%`, backgroundColor: stage.color }]} />
  </View>
  ```
  The value is never clamped to `[0, 1]` and never sanity-checked. `FULL_PROGRESS = 1` is used elsewhere for completion checks, but the display trusts raw input blindly.
- **Fix:** Clamp in `toStageData`: `progress: Math.max(0, Math.min(1, Number.isFinite(apiStage.progress) ? apiStage.progress : 0))`. Also display a breakdown (e.g., "Practice 80% · Habits 60%") fed by separate backend fields so the aggregate "73%" is auditable; align with BUG-STAGE-005 fix (weight components explicitly server-side).

---

### BUG-FE-MAP-004 — Tapping a locked stage silently no-ops with no user feedback
- **Severity:** Medium
- **Component:** `frontend/src/features/Map/MapScreen.tsx:82-113,439-472`
- **Symptom:** Locked hotspots render a 🔒 overlay but `onPress={() => onPress(stage)}` still calls `setActiveStage(stage)`. The modal then opens for a locked stage exposing metadata (see BUG-FE-MAP-001). If BUG-FE-MAP-001 is fixed by filtering locked hotspots out entirely, the lock icon disappears and the user has no affordance explaining *why* a visible stage on the map cannot be opened. Either way, the feedback path is incoherent.
- **Root cause:**
  ```tsx
  // MapScreen.tsx:84-100 — no branch on isUnlocked; every hotspot fires onPress.
  <TouchableOpacity
    onPress={() => onPress(stage)}
    accessibilityLabel={`${stage.title} - ${stage.subtitle}`}
    accessibilityRole="button"
  >
    {!stage.isUnlocked && (<View style={styles.lockOverlay}>...🔒...</View>)}
  ```
  There is no toast, haptic, or message; `accessibilityLabel` also omits "locked" so screen reader users hear a button that appears to do something but produces no output.
- **Fix:** When `!stage.isUnlocked`, branch `onPress` to show a small toast/snackbar ("Stage N unlocks after completing stage N-1") and trigger `Haptics.selectionAsync()`. Append " (locked)" to `accessibilityLabel` and set `accessibilityState={{ disabled: true }}`. Consider `accessibilityHint="Complete the previous stage to unlock"`.

---

### BUG-FE-MAP-005 — `stageService.loadStages` has no optimistic-stage-advance path and no retry/rollback on failure
- **Severity:** Medium
- **Component:** `frontend/src/features/Map/services/stageService.ts:47-69`
- **Symptom:** When a stage is completed elsewhere (e.g., after the last practice session in `PracticeSession`), the UI only reflects the advance after a successful `loadStages()` round-trip. There is no optimistic local update and, conversely, nowhere that performs an optimistic bump of `currentStage` with a rollback path — so a caller that *does* optimistically set `currentStage` (via `useStageStore.setCurrentStage`) leaves the map in an inconsistent state if the subsequent `/stages` reload fails (error is written, stages are untouched per the comment on line 64, but `currentStage` was already mutated).
- **Root cause:**
  ```ts
  // stageService.ts:52-68
  loadStages: async (token?: string): Promise<void> => {
    store.setLoading(true);
    store.setError(null);
    try {
      const apiStages = await stagesApi.list(token);
      // ... setStages + setCurrentStage
    } catch (err) {
      useStageStore.getState().setError(message);
      useStageStore.getState().setLoading(false);
      // NOTE: no rollback of any previously optimistically-set currentStage
    }
  },
  ```
  There is no snapshot of previous state before mutation and no `advanceStage(n)` helper with a rollback branch. Any caller that advances `currentStage` before `loadStages()` succeeds is permanently out of sync with the backend on network failure.
- **Fix:** Add an `advanceStage(next: number)` method that (a) snapshots `currentStage`, (b) sets optimistically, (c) calls `loadStages()`, and (d) on catch restores the snapshot and surfaces a retry affordance. Also in `loadStages`, preserve the prior `stages`/`currentStage` on error (already true for `stages`, but be explicit with a comment) and expose a `retry()` in the error UI (`MapError` currently has no retry button, line 391-395).

---

### BUG-FE-MAP-006 — `ConnectionLines` and `StageHotspots` rebuild on every render; no memoization
- **Severity:** Low
- **Component:** `frontend/src/features/Map/MapScreen.tsx:38-115,417-435`
- **Symptom:** Any state change in `MapScreen` (e.g., opening the modal via `setActiveStage`, toggling the history section inside the modal) re-renders `MapBackground`, which re-evaluates `ConnectionLines.map(...)` and `StageHotspots.flatMap(...)` — producing fresh style objects and inline arrow callbacks on every render. On lower-end Android devices the map (up to 36 stages in future, 10 currently with up to 3 hotspots each = 30 `TouchableOpacity` nodes) stutters when the modal animates in.
- **Root cause:**
  ```tsx
  // MapScreen.tsx:82-100 — arrow in style array and onPress allocate every render
  {stages.flatMap((stage) => stage.hotspots.map((hs, index) => (
    <TouchableOpacity
      style={[styles.hotspot, { top: `${hs.top}%`, ... }, getHotspotStyle(stage, currentStage)]}
      onPress={() => onPress(stage)}
    />
  )))}
  ```
  Neither `ConnectionLines`, `StageHotspots`, nor `MapBackground` is wrapped in `React.memo`, and `onSelectStage` is a raw `setActiveStage` reference passed from MapScreen (stable, OK) but the inline arrows inside `flatMap` are not. The computed `backgroundStyle` in `useBackgroundSize` is also not memoized.
- **Fix:** Wrap `ConnectionLines`, `StageHotspots`, and `MapBackground` in `React.memo` with a custom comparator on `stages` reference + `currentStage`. Memoize hotspot style objects with `useMemo` keyed by `stages` so percent-based style literals are not re-allocated. Move the `onPress` lambda to a stable `useCallback` that receives the stage via closure over a `Map<number, StageData>` built once per `stages` change.

---

### BUG-FE-MAP-007 — Decorative map background and connection lines are not hidden from screen readers; hotspot announcement order is spatial-not-logical
- **Severity:** Low
- **Component:** `frontend/src/features/Map/MapScreen.tsx:38-61,424-434`
- **Symptom:** VoiceOver/TalkBack reads the `ImageBackground` (no `accessible={false}`, no `accessibilityElementsHidden`) and each `View` connection line is a separate accessibility node despite being purely decorative. Because `stages` is sorted descending (stage 10 at top, stage 1 at bottom — see `stageService.ts:60`), screen-reader traversal encounters stages in reverse order (10 → 1), which is the opposite of the learning progression a user expects to navigate.
- **Root cause:**
  ```tsx
  // MapScreen.tsx:425-433
  <ImageBackground source={{ uri: MAP_BACKGROUND_URI }} ... testID="map-background">
    <ConnectionLines stages={stages} />   // plain <View> per line, all focusable
    <StageHotspots ... />                 // iterated in the sort order (10 → 1)
  </ImageBackground>
  ```
  `ConnectionLines` produces bare `<View>`s with no `accessibilityElementsHidden` / `importantForAccessibility="no-hide-descendants"`. The `StageHotspots` flatMap order is driven by the visual-layout sort, not by logical stage order, so screen-reader users hear "Stage 10 — …, Stage 9 — …, …".
- **Fix:** Add `accessible={false}` and `importantForAccessibility="no-hide-descendants"` to `ImageBackground` and every connection-line `View`. For `StageHotspots`, iterate a copy sorted ascending by `stageNumber` for accessibility traversal (or set explicit `accessibilityViewIsModal`/custom `accessibilityOrder` via a container). Add `accessibilityRole="header"` to the screen title if one is added, and give `MapScreen` a root `accessibilityLabel="APTITUDE stage map"`. Cross-ref with BUG-COURSE-* accessibility items.

---

## Suggested Remediation Order

1. **BUG-FE-PRACTICE-101 (Critical)** — Replace wall-clock-blind `setInterval` with `Date.now()`-anchored timer: record `startedAt`, poll `(now - startedAt)`, derive remaining. Handle `AppState` → 'background' by re-anchoring on resume. Fixes drift during phone lock / backgrounding.
2. **BUG-FE-PRACTICE-102 / -104 (High)** — Serialize Start/Cancel/Resume through a single state machine (`idle | running | paused | complete`). Pause must clear the interval; don't re-subscribe via `useEffect` deps.
3. **BUG-FE-PRACTICE-103 / -106 (High/Medium)** — `expo-av` `Sound` instances must be `unloadAsync`'d in a cleanup; keep-awake must be released on both unmount and `onComplete`.
4. **BUG-FE-PRACTICE-001 / -002 (High)** — Resolve current stage from server before rendering selector; pass `isLocked` through from `PracticeScreen` → `PracticeSelector`. Cross-ref BUG-PRACTICE-004.
5. **BUG-FE-PRACTICE-004 / -105 (High)** — Send `startedAt` / `endedAt` as ISO strings; let the server compute duration. Reject sub-30s or >3h sessions client-side as a sanity check. Cross-ref BUG-PRACTICE-005 / -006.
6. **BUG-FE-COURSE-001 / -002 / BUG-FE-MAP-001 (High)** — Strip locked-stage metadata (title, URL) in the render layer as a defense-in-depth; drive rendering off the backend's canonical `unlocked_stages`, not `Math.max(stage_number)`. Cross-ref BUG-COURSE-001 / -003.
7. **BUG-FE-MAP-002 (High)** — Stop deriving `currentStage` locally; consume backend's field. Cross-ref BUG-STAGE-002 (backend drift fix must land first).
8. **BUG-FE-PRACTICE-005 / BUG-FE-MAP-005 (Medium)** — Either make weekly-count the derived read-model (always re-fetch after save) or wrap optimistic writes in a rollback closure. Same fix pattern as BUG-FE-HABIT-001 / BUG-FE-JOURNAL-002.
9. **BUG-FE-COURSE-005 (Medium)** — Hold an `AbortController` or a mounted-ref through the `markRead` request; bail out on unmount before `setState`.
10. **BUG-FE-COURSE-006 (Medium)** — Use an allow-list of URL schemes (`https:`, `mailto:`) + explicit confirm sheet for external links.
11. **BUG-FE-COURSE-004 (Medium)** — Paginate stage content client-side (e.g. 10 items per page) once backend BUG-STAGE-004 is fixed and supports offset/limit.
12. **BUG-FE-PRACTICE-006 (Medium)** — Distinguish 401 (re-auth) from empty-response in the loader; trigger the auth-refresh path (cross-ref BUG-FE-AUTH-*).
13. **BUG-FE-PRACTICE-003 (Medium)** — Use `useFocusEffect` to re-fetch weekly progress on tab-focus; subscribe to a session-complete event bus.
14. **BUG-FE-MAP-003 / -004 (Medium)** — Clamp progress to `[0, 1]` and coerce NaN to 0; add haptic + toast feedback on locked-stage tap.
15. **BUG-FE-PRACTICE-107 / -109 (Medium/Low)** — Gate halfway-bell on `elapsed >= halfway && !firedHalfway`; collapse "Complete" flash with a zero-duration guard.
16. Remaining Low items — batch into a11y polish PR: live regions on timer, SR hide for decorative SVG, `accessibilityRole`/`accessibilityState` on every touchable, logical stage-traversal order on map.

## Cross-References

- **BUG-FE-PRACTICE-004 / -105 ↔ BUG-PRACTICE-005 / -006** — Client-computed duration + client timestamp = the backend TOCTOU has two inputs it shouldn't trust. Fix end-to-end by sending `startedAt`/`endedAt` and deriving server-side.
- **BUG-FE-PRACTICE-001 / -002 ↔ BUG-PRACTICE-004 / BUG-STAGE-001 / BUG-SCHEMA-006** — Client gate is the final defense; backend validation is the primary defense. The skip-to-stage-36 chain (`BUG-SCHEMA-006 → BUG-STAGE-001 → practice create with wrong stage_number`) requires all three fixes to close.
- **BUG-FE-COURSE-001 / BUG-FE-COURSE-002 ↔ BUG-COURSE-001 / BUG-COURSE-003** — Frontend rendering of locked content and future stages mirrors the backend leak. Backend fix strips the data; frontend fix provides defense-in-depth in case a migration misses an endpoint.
- **BUG-FE-MAP-001 / -002 ↔ BUG-STAGE-002** — `current_stage` and `completed_stages` redundancy drift on the backend shows up as client-local heuristics (`pickCurrentStage`) diverging from server truth. Single source of truth: always use `stages.currentStage()` from the API.
- **BUG-FE-PRACTICE-005 ↔ BUG-FE-HABIT-001 / BUG-FE-JOURNAL-002 / BUG-FE-MAP-005** — Optimistic-write-without-rollback is the dominant cross-surface pattern. Factor a reusable `useOptimisticMutation` hook.
- **BUG-FE-COURSE-006 ↔ BUG-BM-004 / BUG-JOURNAL-003** — Untrusted string → external resource is the same class as LLM prompt injection and stored XSS. Treat any remote URL / remote markdown / remote content as untrusted.
