# ritual-07: Mode view primitives + audio/haptics adapters

**Labels:** `ritual-practice`, `frontend`, `feature`, `priority-high`
**Epic:** Ritual Practice Screen
**Depends on:** ritual-06 (engine hook)
**Estimated LoC:** ~600 (5 small components + 2 adapters + tests)

## Problem

The engine emits a `RitualState`; we now need the visual layer that consumes
it for the four "primitive" modes. Each view is intentionally small —
presentation only — so that swapping audio adapters or restyling doesn't
ripple into engine logic.

This issue also ships the audio + haptics adapters so the engine has
something real to call in production. Tarot and 5-4-3-2-1 are deferred to
ritual-08 (their UX is meaningfully different and pulls in card data).

## Scope

Five view components, two adapters, one shared "controls bar". All
presentational; engine-pure tests live in ritual-06.

## Tasks

1. **Adapters** in `frontend/src/features/Practice/engine/adapters/`
   - `audio.ts`:
     - `AudioAdapter = { play(kind: CueKind): Promise<void>, dispose():
       void }`.
     - `createNoopAudioAdapter()` — returns resolved promises; logs nothing
       (used in tests + when assets are missing).
     - `createExpoAudioAdapter()` — uses `expo-av` to load three small
       static cues (`bell-start.mp3`, `bell-half.mp3`, `bell-end.mp3`,
       `metronome-tick.wav`) from `frontend/assets/sounds/`. If a file is
       missing at load time, fall back to no-op for that cue and log a
       single warning per missing file. Do **not** throw — a missing asset
       must not break the practice.
   - `haptics.ts`:
     - `HapticsAdapter = { cue(kind: CueKind): void }`.
     - Wraps `expo-haptics` `notificationAsync(Success)` for end cues,
       `impactAsync(Light)` for ticks, `impactAsync(Medium)` for interval
       bells, no-op for `metronome_tick` (haptics-on-every-beat is awful).
     - `createNoopHapticsAdapter()` for tests.

2. **Shared `RitualControls` bar** —
   `frontend/src/features/Practice/views/RitualControlsBar.tsx`
   - Renders Start / Pause / Resume / Cancel based on `status`.
   - Accessible labels (`accessibilityLabel`, `accessibilityRole="button"`).
   - Re-used by every mode view to keep visual consistency.

3. **`MeditationTimerView.tsx`**
   - Circular progress ring (use `react-native-svg` if present in
     `package.json`; otherwise a simple `<View>`-based ring with absolute
     positioning to avoid adding a dep — pick one and document the choice).
   - Centre text: `mm:ss` remaining.
   - Pure consumer of `RitualState` + `RitualControls` props (no engine
     coupling — testable with hand-rolled props).

4. **`CountUpTimerView.tsx`**
   - Centre text: `mm:ss` elapsed.
   - No ring (or a faint indeterminate animation behind the digits — pick
     one). "End session" button calls `controls.complete()`.

5. **`MetronomeView.tsx`**
   - Big BPM display, animated dot pulsing on each `metronome_tick` cue
     (use `Animated.Value` driven from `state.cuesStruck`).
   - Embedded mini timer (`mm:ss`) below.

6. **`RepCounterView.tsx`**
   - Large `repCount` digits.
   - "+1" tap-anywhere area (`Pressable` over the whole frame) calling
     `controls.tap()`.
   - Subtitle showing `unit_label` from config.
   - Optional time cap mini-display.

7. **`IntervalBellView.tsx`**
   - Centre text: `mm:ss` until next bell (derived from
     `state.nextCueAtMs - state.elapsedMs`).
   - Below: small list of all interval offsets with the upcoming one
     highlighted, struck ones checked.

8. **Tests** — `frontend/src/features/Practice/views/__tests__/`
   - One snapshot/render test per view that:
     - Renders with a fabricated `RitualState`/`RitualControls`.
     - Asserts the right buttons appear per `status`.
     - Fires the documented controls (e.g. tap on `RepCounterView` triggers
       `controls.tap`).
   - Adapter tests:
     - `createNoopAudioAdapter().play('start_bell')` resolves without
       throwing.
     - `createExpoAudioAdapter()` is mocked in jest setup
       (`__mocks__/expo-av.ts` if not already there); a missing-asset
       scenario logs a single warning and falls back to no-op.

## Acceptance Criteria

- Each view renders correctly for all four lifecycle statuses.
- Adapters are mockable; tests don't pull in real audio.
- No engine state lives inside view components — they are pure consumers.
- Coverage targets met.

## Files to Create / Modify

| File | Action |
|------|--------|
| `frontend/src/features/Practice/engine/adapters/audio.ts` | **Create** |
| `frontend/src/features/Practice/engine/adapters/haptics.ts` | **Create** |
| `frontend/src/features/Practice/views/RitualControlsBar.tsx` | **Create** |
| `frontend/src/features/Practice/views/MeditationTimerView.tsx` | **Create** |
| `frontend/src/features/Practice/views/CountUpTimerView.tsx` | **Create** |
| `frontend/src/features/Practice/views/MetronomeView.tsx` | **Create** |
| `frontend/src/features/Practice/views/RepCounterView.tsx` | **Create** |
| `frontend/src/features/Practice/views/IntervalBellView.tsx` | **Create** |
| `frontend/src/features/Practice/views/__tests__/*.test.tsx` | **Create** |
| `frontend/assets/sounds/` | **Create** *(empty placeholder; real files in a separate audio task)* |
| `frontend/package.json` | Modify *(add `expo-av`, `expo-haptics`, `expo-keep-awake` if not already present)* |

## If you blow the budget

Most likely overflow is the SVG ring math. Lift the ring into its own
`ProgressRing.tsx` component (~100 LoC) with its own snapshot tests, and
ship it as `07a`. The remaining four views + adapters fit comfortably in
`07b`.
