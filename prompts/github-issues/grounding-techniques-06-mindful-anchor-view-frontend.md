# grounding-techniques-06: Build `MindfulAnchorView` (frontend)

**Labels:** `frontend`, `feature`, `practice`
**Epic:** [Generalize grounding techniques](grounding-techniques-epic.md)
**Depends on:** [grounding-techniques-02](grounding-techniques-02-mindful-anchor-mode-backend.md)
**Estimated LoC:** ~200

## Role

You are a React Native engineer extending Adepthood's ritual session
engine. You add a new view component, wire it into the engine
dispatcher, and ship a comprehensive test file.

## Goal

Build `MindfulAnchorView` to drive the **Touch Grass** and **Mindful
Eating** ritual UX off a `MindfulAnchorConfig`. The view should:

- Show the instruction prominently
- (If options are configured) show an option chooser before "Begin"
- Once running, show a live elapsed-time counter
- Gate the Save button on `met_min_duration`, but with a soft nudge,
  not a hard lock (user can save anyway after a confirmation)
- Emit `MindfulAnchorMetadata` to the parent on save

## Context

Reference view: `SenseGroundingView.tsx`. Reference dispatcher:
`ActiveRitualSession.tsx`. Reference engine state:
`engine/types.ts` (`RitualState`, `RitualControls`).

`mindful_anchor` differs from the existing step-based modes — it has
no `currentStepIndex` semantic. The "Begin" → "Mark complete" flow
maps cleanly to engine `status` transitions: `idle → running →
complete`. The view doesn't call `controls.tap()` — it calls
`controls.complete()` (or whatever the engine's "finish now" action
is — confirm name when reading the engine).

## Tasks

1. **Add types to `frontend/src/features/Practice/engine/types.ts`**
   - `MindfulAnchorOption`: `{ key: string; label: string; description?:
     string }`
   - `MindfulAnchorConfig`: `{ mode: 'mindful_anchor'; instruction:
     string; min_duration_seconds: number; options: readonly
     MindfulAnchorOption[]; require_option_choice: boolean }`
   - Extend the `RitualConfig` union.
   - `MindfulAnchorMetadata`: `{ mode: 'mindful_anchor';
     chosen_option_key: string | null; duration_seconds: number;
     met_min_duration: boolean }`

2. **Build `frontend/src/features/Practice/views/MindfulAnchorView.tsx`**
   - Sections:
     - Instruction card (always visible)
     - Option chooser (visible while `status === 'idle'` if
       `options.length > 0`)
     - Elapsed-time display (visible while `status === 'running'`)
       — re-renders once per second using a local `useEffect` interval;
       does **not** mutate engine state.
     - `RitualControlsBar` (reused)
     - Save button (visible when `status === 'complete'`)
   - Soft duration gate:
     - If `met_min_duration === false` when the user taps Save, show
       a confirm dialog: "It looks like you only spent X seconds. Take
       another moment, or save anyway?" — Cancel returns to the running
       state; Save anyway proceeds.
   - Local state:
     - `selectedOptionKey: string | null`
     - `elapsedSeconds: number` (derived from `state.startedAt`)
   - If `require_option_choice === true`, the Begin button is disabled
     until an option is selected.

3. **Wire dispatcher**
   - In `ActiveRitualSession.tsx`, add the
     `mode === 'mindful_anchor'` case. Translate state on save into
     `MindfulAnchorMetadata`:
     ```
     {
       mode: 'mindful_anchor',
       chosen_option_key: selectedOptionKey,
       duration_seconds: elapsedSeconds,
       met_min_duration: elapsedSeconds >= config.min_duration_seconds,
     }
     ```

4. **API client types**
   - Update `frontend/src/api/` types if practice config / metadata is
     mirrored there.

5. **Tests** — `frontend/src/features/Practice/views/__tests__/MindfulAnchorView.test.tsx`
   - Renders instruction text
   - Renders option chooser when options are present
   - Disables Begin when `require_option_choice && !selectedOption`
   - Tapping an option enables Begin
   - After Begin, elapsed time display appears
   - Save below `min_duration_seconds` shows the confirm dialog
   - Save after `min_duration_seconds` fires `onSave` directly
   - Snapshot of the chooser

## Acceptance Criteria

- [ ] `npm run lint` clean
- [ ] `npx tsc --noEmit` passes
- [ ] `npm test` green
- [ ] `ActiveRitualSession` dispatches `mindful_anchor` to the new view
- [ ] Manual smoke: start a Touch Grass session → pick "Grass" → Begin
      → wait 5s → Save → confirm dialog appears → "Save anyway" →
      session row appears with `mode_metadata.mode = "mindful_anchor"`
- [ ] Manual smoke: same flow, wait ≥120s before Save → no confirm
      dialog, save proceeds directly
- [ ] No changes to existing view behavior

## Files to Create / Modify

| File | Action |
|------|--------|
| `frontend/src/features/Practice/engine/types.ts` | Modify |
| `frontend/src/features/Practice/views/MindfulAnchorView.tsx` | **Create** |
| `frontend/src/features/Practice/views/__tests__/MindfulAnchorView.test.tsx` | **Create** |
| `frontend/src/features/Practice/components/ActiveRitualSession.tsx` | Modify |
| `frontend/src/api/` (types module) | Possibly modify |

## Constraints

- Soft duration gate only — never hard-lock the save. Users with
  legitimate reasons to cut short must be able to record their session.
- Use a 1-Hz interval for the elapsed-time display; clear it on
  unmount and on status change to avoid leaks.
- Mode dispatch in `ActiveRitualSession.tsx` only.
- Match design tokens (`@/design/tokens`) used by `SenseGroundingView`.
- Accessibility: the option chooser uses `accessibilityRole="radio"`,
  the elapsed time is announced as a polite live region, the save
  confirm dialog is keyboard-dismissible.

## Example: Touch Grass session shape

```json
{
  "mode_metadata": {
    "mode": "mindful_anchor",
    "chosen_option_key": "grass",
    "duration_seconds": 145,
    "met_min_duration": true
  }
}
```
