# practice-redesign-08: Minimalist redesign of the Create Practice wizard

**Labels:** `enhancement`, `frontend`, `ritual-practice`
**Epic:** [Practice frontend redesign](practice-redesign-epic.md)
**Depends on:** #06 (shared copy/duration helper), #07 (visual language).
**Estimated LoC:** ~250

## Problem

The Create Practice wizard is the deepest authoring surface and the biggest
remaining bloat risk. After the IA/copy/visual passes it should match the rest
of the redesign, but today it reads as a dense four-step form with wordy
guidance.

Current state — `frontend/src/features/Practice/screens/CreatePracticeWizard.tsx`:
- Step indicator "1 / 4" (lines 234-250) and an entry step with two cards
  (264-275), a mode step, a configure step ("Next: name + save", line 332), and a
  metadata step (name 439, description 450, instructions 464, duration 476,
  stage chips 505-520, "Save practice" 417, Back 607).
- Verbose helper copy ("Most adepts find it fastest to copy a preset and tweak
  it.", lines 261/323-325) — partly trimmed in #06; finish the job here.

## Scope

A minimalist visual + flow pass over the wizard only: cleaner step indicator,
calmer entry choice, consistent spacing/typography from the tokens, and tighter
field grouping. No change to what the wizard submits (`practices.create` +
optional `userPractices.create`) or which forms it routes to. The mode picker
(`ModePicker`) and the per-mode forms are not restructured.

## Tasks

1. **Calm the step chrome** — replace the dense "1 / 4" indicator with a quiet
   progress treatment consistent with #07 (e.g. a slim segmented bar or
   "Step 2 of 4" in `text.secondaryAccessible`). One heading per step.
2. **Tighten the entry step** — the two entry cards ("Start from a preset" /
   "Start from scratch") become two clean, equal-weight options with one-line
   subtitles (no paragraph). "Start from a preset" still routes to the `Catalog`
   route (per #01).
3. **Group the metadata step** — name/description/instructions/duration/stage in
   a single calm column with consistent spacing; auto-suggested duration uses the
   #06 `formatDuration` helper; the stage assignment reads as one clear optional
   control.
4. **Finish the copy trim** — any wizard helper sentence not already shortened in
   #06 becomes one short line or is removed where the UI is self-evident.
5. **Tests** — update `screens/__tests__/CreatePracticeWizard.test.tsx`: step
   navigation still works, the entry choices route correctly, submit still calls
   `practices.create` (and `userPractices.create` when a stage is chosen). Use
   named-style assertions for the new chrome.

## Acceptance Criteria

- [ ] The wizard's step chrome, spacing, and typography match the #07 visual language.
- [ ] Entry, configure, and metadata steps each read as one calm screen, not a dense form.
- [ ] No behaviour change: the same submit calls fire and route to the same forms.
- [ ] `npm test`, `npx tsc --noEmit`, `npm run lint` green; coverage unchanged.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Practice/screens/CreatePracticeWizard.tsx` | Modify |
| `frontend/src/features/Practice/screens/__tests__/CreatePracticeWizard.test.tsx` | Modify |

## Constraints

- Frontend only. Do not change submit behaviour, the mode dispatch, or the per-mode forms.
- All spacing/colour/radii from `design/tokens.ts`; tap targets ≥44dp; a11y (step announced, fields labelled) preserved.
- Reuse the #06 `formatDuration` helper; do not reintroduce a second duration phrasing.
