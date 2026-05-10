# ritual-06: useRitualEngine hook (state machine)

**Labels:** `ritual-practice`, `frontend`, `feature`, `priority-high`
**Epic:** Ritual Practice Screen
**Depends on:** ritual-01 (mode_config shape)
**Estimated LoC:** ~600 (hook + reducer + tests)

## Problem

Each preset uses one of seven modes (`meditation_timer`, `count_up`,
`metronome`, `interval_bell`, `rep_counter`, `sense_grounding`, `tarot`).
Every mode shares the same lifecycle (`idle → running → paused → complete`),
the same need for a wall-clock-aware tick, the same need to schedule audio /
haptic cues, and the same need to emit a `SessionMetadata` payload at the
end. Implementing this per-mode would duplicate logic and tests.

Build one engine that takes a `ModeConfig`, drives a state machine, and
exposes the fields and callbacks every mode view needs.

## Scope

`useRitualEngine(config: ModeConfig, deps: EngineDeps)` returns a `RitualState`
+ a small `RitualControls` API. Pure logic with injected adapters for time,
audio, and haptics so it's testable with `jest.useFakeTimers()`.

## Tasks

1. **Create `frontend/src/features/Practice/engine/types.ts`**
   - `EngineStatus = 'idle' | 'running' | 'paused' | 'complete'`
   - `RitualState`:
     - `status: EngineStatus`
     - `elapsedMs: number`
     - `remainingMs: number | null` (null for `count_up`)
     - `progress: number` (0..1; 0 for `count_up` and modes without a target)
     - `repCount: number` (only meaningful for `rep_counter`)
     - `currentStepIndex: number` (sense-grounding step / tarot card index)
     - `nextCueAtMs: number | null` (next bell offset, for interval bell view)
     - `cuesStruck: number` (count of bells/intervals played so far)
   - `RitualControls`:
     - `start()`, `pause()`, `resume()`, `cancel()`, `complete()`
     - `tap()` — used by `rep_counter` (and by sense-grounding for "mark
       sense done").
     - `advanceStep()` — used by sense-grounding / tarot when stepping past
       the per-step interval.
   - `EngineDeps`:
     - `now: () => number` (wraps `Date.now`).
     - `setIntervalMs: (cb, ms) => Handle`, `clearInterval: (h) => void`.
     - `audio: AudioAdapter` (see ritual-07).
     - `haptics: HapticsAdapter`.
     - All optional with safe defaults so tests can inject mocks and prod
       code wires through `expo-av` / `expo-haptics`.

2. **Create `engine/reducer.ts`**
   - Pure reducer `(state, action) -> state` covering:
     - `START`, `PAUSE`, `RESUME`, `CANCEL`, `COMPLETE`,
     - `TICK { now }` (recomputes `elapsedMs`, `remainingMs`, `progress`,
       `nextCueAtMs`, possibly emits a `cue`),
     - `TAP` (rep_counter: bump `repCount`; sense_grounding: advance step),
     - `ADVANCE_STEP` (tarot: reveal next card / move to next interval).
   - Reducer is mode-aware via the discriminated `config` it receives — keep
     all mode logic in small per-mode `reduce<Mode>(state, action, config)`
     functions called from a top-level switch on `config.mode`. This keeps
     each mode reducer small and independently testable.

3. **Cue scheduler** — `engine/cues.ts`
   - Pure function `scheduledCues(config: ModeConfig): Cue[]` returning
     a sorted list of `{ atMs: number, kind: 'start_bell' | 'halfway_bell'
     | 'end_bell' | 'interval_bell' | 'metronome_tick' }`.
   - For `metronome`, the schedule yields ticks every `60_000 / bpm` ms
     until `duration_minutes * 60_000` (cap at 10k ticks defensively).
   - For `interval_bell`, expands `interval_minutes` or `cue_offsets_minutes`
     into discrete `interval_bell` cues.
   - The reducer's `TICK` handler walks the (sorted, immutable) cue list with
     a single index pointer; never re-iterates the whole list.

4. **The hook** — `engine/useRitualEngine.ts`
   - `useReducer` over the reducer + a `useEffect` that owns the interval
     ticker and disposes it on unmount.
   - Tick frequency: 100ms (smooth UI, cheap CPU). Document the choice.
   - Auto-completes when `remainingMs <= 0` (modes with a target).
   - Calls `deps.audio.play(cue.kind)` and `deps.haptics.cue(cue.kind)` as
     cues fire.
   - Returns `[state, controls]`.

5. **Tests** — `engine/__tests__/`
   - `reducer.test.ts` (the lion's share):
     - `meditation_timer` 10-min: ticks, halfway cue at 5min iff
       `halfway_bell`, end cue at 10min, status → `complete`.
     - `count_up`: never auto-completes; `progress` stays 0; `complete()`
       transitions to `complete` and freezes `elapsedMs`.
     - `metronome`: with bpm=60, exactly 600 ticks across 10 minutes;
       embedded timer's halfway/end cues still fire.
     - `interval_bell`: `interval_minutes=5`, `duration_minutes=20` → 4
       interval cues + start + end. `cue_offsets_minutes=[3,7,12]` mode
       fires only those three plus start/end.
     - `rep_counter`: `tap()` increments `repCount`; auto-completes on
       reaching `target_reps`; if `time_cap_minutes` set, also
     - completes when cap hits.
     - `sense_grounding`: `tap()` advances `currentStepIndex` through every
       prompt; auto-completes after the last.
     - `tarot`: `per_card_minutes=5` → after `start()`, status stays
       running, end cue at 5min, `currentStepIndex` lands on the day's card
       (engine takes a `startCardIndex` from the hook caller — see ritual-08).
     - Pause/resume preserves elapsed; cancel resets to idle without
     - emitting `complete`.
   - `cues.test.ts` — pure scheduler; snapshot the cue list per mode.
   - `useRitualEngine.test.tsx` — render-hook test verifying ticker
     wiring + cleanup; uses `jest.useFakeTimers()`.

## Acceptance Criteria

- All 7 modes drive correctly through pause/resume/cancel/complete.
- Cue scheduler is deterministic and pure.
- No real timers leak between tests.
- 100% line coverage on `reducer.ts` and `cues.ts`; ≥ 90% on the hook.

## Files to Create / Modify

| File | Action |
|------|--------|
| `frontend/src/features/Practice/engine/types.ts` | **Create** |
| `frontend/src/features/Practice/engine/reducer.ts` | **Create** |
| `frontend/src/features/Practice/engine/cues.ts` | **Create** |
| `frontend/src/features/Practice/engine/useRitualEngine.ts` | **Create** |
| `frontend/src/features/Practice/engine/__tests__/reducer.test.ts` | **Create** |
| `frontend/src/features/Practice/engine/__tests__/cues.test.ts` | **Create** |
| `frontend/src/features/Practice/engine/__tests__/useRitualEngine.test.tsx` | **Create** |

## If you blow the budget

Likely split: `06a` ships types + reducer + cues + their tests (~400 LoC,
pure logic, no React). `06b` ships the hook itself + ticker effect + the
render-hook test (~200 LoC). `06b` blocks the mode views; `06a` is enough to
unblock validation and prototyping.
