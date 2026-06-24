# audit-destub-02: Wire the "Start from a preset" CTA to the preset picker

**Labels:** `audit-destub`, `frontend`, `stub`, `priority-high`
**Epic:** De-Stub: Make Aspirational Features Real
**Estimated LoC:** ~180  (hard cap 700)

## Problem
In `frontend/src/features/Practice/screens/CreatePracticeWizard.tsx:184`, the entry step renders
`<EntryStep onPickPreset={props.onCancel} ... />` — the **"Start from a preset"** CTA is wired
straight to `onCancel`, which dismisses the wizard (`goBack`). The recommended on-ramp into the
feature silently closes the flow instead of opening the catalog/preset picker.
**Current state:** §5.1 class **stub** (`2026-06-24_ADEPTHOOD_FULL_AUDIT.md` §6, row 2; §2 item 7).
This path is **supposed to be real for ship** — it is the primary intended entry into the wizard.

## Scope
**Covers:** routing the "Start from a preset" CTA to the existing Practice catalog / preset
selector so a chosen preset pre-fills the wizard's mode + config, and replacing the `onCancel`
wiring at line 184. **Does NOT cover:** building a new picker UI (the catalog already exists —
see §5.2's `PracticeCatalogScreen.tsx` / `PracticeSelector.tsx`), virtualizing those lists
(tracked under `audit-render`), or the "Start from scratch" path (already correct).

## Tasks
1. **Route the CTA** — change `onPickPreset` to navigate to the preset picker rather than
   `onCancel`. Use the existing catalog navigation target; pass a selection callback (or route
   param) that returns the chosen preset's mode + config.
2. **Pre-fill on return** — when a preset is selected, seed `WizardState.mode` and
   `WizardState.config` from it and advance to the `configure` step (skip `mode` selection, since
   a preset already fixes the mode). TDD: a test that pressing "Start from a preset", selecting a
   preset, and returning lands the wizard on `configure` with the preset's mode/config — and that
   it does **not** dismiss the wizard.
3. **Guard cancel** — confirm `onCancel` is still reachable from its real control (back/close), and
   that the entry-step "Start from a preset" no longer triggers it. TDD: assert `onCancel` is not
   invoked by the preset CTA.

## Acceptance Criteria
- [ ] Pressing "Start from a preset" opens the preset picker; it never calls `onCancel`/`goBack`.
- [ ] Selecting a preset returns to the wizard at the `configure` step with the preset's mode and
      config applied.
- [ ] The "Start from scratch" path and the explicit cancel/close control are unchanged.
- [ ] No existing tests break; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on --all-files.

## Files to Create/Modify
| File | Action |
|------|--------|
| `frontend/src/features/Practice/screens/CreatePracticeWizard.tsx` | Modify (route CTA + pre-fill from preset) |
| `frontend/src/features/Practice/screens/__tests__/CreatePracticeWizard.test.tsx` | Modify (preset-CTA navigation + no-dismiss tests) |
