# ritual-08: Preset views — 5-4-3-2-1 grounding + Tarot meditation

**Labels:** `ritual-practice`, `frontend`, `feature`, `priority-medium`
**Epic:** Ritual Practice Screen
**Depends on:** ritual-06 (engine), ritual-07 (controls bar)
**Estimated LoC:** ~500 (two views + tarot data + tests)

## Problem

Two presets have UX that doesn't fit the generic timer/metronome/counter
mould:

- **5-4-3-2-1 grounding** — the spec wants the header `"5-4-3-2-1"` and a
  button labelled `"Mark sight done"` that becomes `"Mark touch done"`,
  `"Mark hearing done"`, `"Mark smell done"`, `"Mark taste done"` as the
  user steps through the senses. It's a *sequence-tap* UI, not a clock.
- **Tarot meditation** — the spec wants a card from the major arcana
  displayed for a 5-minute timer. The timer must be **hidden during
  meditation** and revealed at completion. The deck progresses from "The
  Fool" to "The World" over 22 days.

Both consume `useRitualEngine` (sense_grounding / tarot modes) but render
their own custom layouts.

## Scope

Build the two preset views, plus a small tarot-data module + a deterministic
"day index → card" resolver.

## Tasks

1. **Tarot data** — `frontend/src/features/Practice/data/tarot.ts`
   - Constant `MAJOR_ARCANA: TarotCard[]` of length 22:
     `{ index: 0..21, name: 'The Fool' … 'The World', keyword: string,
     symbolism: string }`. Keep `keyword` and `symbolism` short (≤ 80 chars).
   - Helper `cardForDayIndex(daysSinceStart: number): TarotCard` returning
     `MAJOR_ARCANA[daysSinceStart % 22]`. Pure function; tested.
   - **No image assets in this issue.** The view renders the card name + a
     stylised border + the keyword. A future asset task can swap in
     illustrations once licensing is sorted.

2. **`SenseGroundingView.tsx`**
   - Header: large `5-4-3-2-1` badge + the current sense's count
     (e.g. "5 things you can SEE").
   - Per-sense prompt text from `config.prompts[currentStepIndex]`.
   - Big primary button: `"Mark {sense} done"` → calls `controls.tap()`
     which the sense_grounding reducer interprets as `advanceStep`.
   - When `currentStepIndex === prompts.length`, status auto-completes (the
     engine handles that in ritual-06); the view shows a "Grounding
     complete" final card with the Save button.
   - Accessibility: `accessibilityLabel` updates per step; the header is a
     `accessibilityRole="header"`.

3. **`TarotMeditationView.tsx`**
   - Props: `state`, `controls`, `card: TarotCard`, `hideTimer: boolean`.
   - When `status === 'idle'`: show the card with name + keyword + a
     "Begin meditation" button.
   - When `status === 'running'` and `hideTimer`: render only the card
     (no timer, no controls bar) plus a long-press "Cancel" affordance
     (so the user has an exit but can't see the clock).
   - When `status === 'paused'`: timer + standard controls visible
     (paused state is escape hatch; honesty over purism).
   - When `status === 'complete'`: show the timer reading (now visible),
     the card, and the post-session entry-point CTA.

4. **Day-index plumbing**
   - `TarotMeditationView` receives `card` from its parent — the view never
     reads from a clock itself. The parent (`PracticeScreen` in ritual-11)
     computes `daysSinceStart` from `UserPractice.start_date` and the
     user's local timezone, then calls `cardForDayIndex` to pick the card.
   - Document this contract in the view's prop docstring so future callers
     don't accidentally re-compute the date inside the view.

5. **Tests** — `frontend/src/features/Practice/views/__tests__/`
   - `tarot.test.ts`:
     - `MAJOR_ARCANA` has length 22, indices 0..21 unique, names in
       traditional order (snapshot the names).
     - `cardForDayIndex(0) === The Fool`, `cardForDayIndex(21) === The
       World`, `cardForDayIndex(22) === The Fool` (wrap), `cardForDayIndex(
       100) === MAJOR_ARCANA[100 % 22]`.
   - `SenseGroundingView.test.tsx`:
     - Renders the right "Mark <sense> done" label per `currentStepIndex`.
     - Tap fires `controls.tap()`.
     - At `status='complete'` shows the completion card.
   - `TarotMeditationView.test.tsx`:
     - `status='running' && hideTimer` → no `mm:ss` text in tree.
     - `status='paused'` shows controls + timer.
     - `status='complete'` shows timer + Save CTA.
     - Card name + keyword always visible.

## Acceptance Criteria

- 5-4-3-2-1 view drives the engine through five taps and finishes.
- Tarot view never leaks the clock during the meditative window.
- Card rotation is deterministic and wraps after 22 days.
- Coverage targets met.

## Files to Create / Modify

| File | Action |
|------|--------|
| `frontend/src/features/Practice/data/tarot.ts` | **Create** |
| `frontend/src/features/Practice/views/SenseGroundingView.tsx` | **Create** |
| `frontend/src/features/Practice/views/TarotMeditationView.tsx` | **Create** |
| `frontend/src/features/Practice/views/__tests__/tarot.test.ts` | **Create** |
| `frontend/src/features/Practice/views/__tests__/SenseGroundingView.test.tsx` | **Create** |
| `frontend/src/features/Practice/views/__tests__/TarotMeditationView.test.tsx` | **Create** |

## If you blow the budget

Move the 22-card data table into a JSON file (`tarot.json`) imported via
TypeScript's `resolveJsonModule` so the LoC count drops to just the helper.
