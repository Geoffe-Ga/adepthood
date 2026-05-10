# ritual-09: Ritual configurator UI

**Labels:** `ritual-practice`, `frontend`, `feature`, `priority-medium`
**Epic:** Ritual Practice Screen
**Depends on:** ritual-03 (PATCH endpoint), ritual-06 (engine config types)
**Estimated LoC:** ~600

## Problem

Users must be able to "build their own ritual": rename the practice, change
durations, edit the metronome BPM, add or remove interval bells, and edit
sense-grounding prompts — and persist those edits per-user via the new
`PATCH /user-practices/{id}/customize` endpoint.

Mode is **not** editable here (the spec says practices can be replaced;
mode-shifting is a replacement, not a tweak — see ritual-10).

## Scope

A `RitualConfiguratorSheet` modal that takes the active practice + its
effective config and renders a per-mode editor. On save it calls the
customization endpoint and refreshes the parent's practice state.

## Tasks

1. **`RitualConfiguratorSheet.tsx`**
   - Bottom-sheet modal (use the project's existing modal primitive — check
     `frontend/src/components/` first; if none exists, a simple `Modal`
     with a styled card is fine).
   - Header: practice name (editable inline), aspect chip, "Cancel" / "Save".
   - Body: dispatches to a per-mode form by `effective_config.mode`:
     - `<MeditationTimerForm>`: duration slider/numeric input (minutes,
       0.5–120), three checkbox toggles for start/halfway/end bells.
     - `<MetronomeForm>`: BPM stepper (20–240 with ±1 / ±5 buttons) +
       embedded `<MeditationTimerForm>` for the surrounding window.
     - `<IntervalBellForm>`: choice between "even intervals" (single
       `interval_minutes` numeric) and "custom offsets" (chip list with
       add/remove); duration slider; tone picker.
     - `<RepCounterForm>`: target reps numeric, unit label text, optional
       time cap minutes.
     - `<SenseGroundingForm>`: reorderable list of prompts, edit text per
       prompt, add/remove. Sense picker per row (constrained to the 5
       literals).
     - `<CountUpForm>`: optional soft-cap minutes.
     - `<TarotForm>`: per-card minutes, hide-timer toggle.

2. **State + validation**
   - Local form state initialised from `effective_config`.
   - Save button disabled when:
     - No fields changed, OR
     - Validation fails — reuse the Pydantic-side rules in TS (e.g. BPM
       20..240, duration ≥ 0.5, prompts non-empty). Centralise in
       `frontend/src/features/Practice/engine/validation.ts` so the rules
       have one home. Tests cover each rule.
   - On save: build a `mode_config_override` payload, call
     `userPractices.customize(userPracticeId, { custom_name, mode_config_override })`,
     toast on success, surface API error via `formatApiError`.

3. **API client** — extend `frontend/src/api/index.ts`
   - Add `userPractices.customize(id, payload)` POSTing to
     `PATCH /user-practices/{id}/customize` (HTTP method PATCH).
   - Add `clear` semantics: passing `mode_config_override: null` clears the
     override. The form's "Reset to default" button uses this.

4. **Tests** — `__tests__/RitualConfiguratorSheet.test.tsx` plus
   per-form tests
   - For each mode, the right form renders given the mode config.
   - Editing fields builds the right payload on save.
   - Validation blocks save when out-of-range; error text is displayed.
   - "Reset to default" sends `mode_config_override: null`.
   - API error response renders the formatted error.
   - `validation.test.ts` covers each rule round-trip with the backend
     spec table from ritual-01.

## Acceptance Criteria

- Each of the 7 modes has a working form.
- Saving updates the active `UserPractice` via PATCH.
- "Reset to default" clears the override.
- All numeric ranges match the backend Pydantic constraints (regression
  test for any future drift).
- Coverage targets met.

## Files to Create / Modify

| File | Action |
|------|--------|
| `frontend/src/features/Practice/configurator/RitualConfiguratorSheet.tsx` | **Create** |
| `frontend/src/features/Practice/configurator/forms/*.tsx` | **Create** (7 forms) |
| `frontend/src/features/Practice/engine/validation.ts` | **Create** |
| `frontend/src/api/index.ts` | Modify (add `customize`) |
| `frontend/src/features/Practice/configurator/__tests__/*.test.tsx` | **Create** |
| `frontend/src/features/Practice/engine/__tests__/validation.test.ts` | **Create** |

## If you blow the budget

Forms are the obvious split. Land the sheet shell + 3 forms (timer,
metronome, interval-bell — covers 6 of 10 presets) as `09a`; ship the
remaining 4 forms (rep counter, sense grounding, count-up, tarot) as `09b`.
The sheet must guard against an unknown mode by rendering a "configuration
not yet available — long-press to replace" message so 09a doesn't crash for
unimplemented modes.
