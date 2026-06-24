# audit-destub-09: Build the missing configurator forms (tallied_grounding, mindful_anchor)

**Labels:** `audit-destub`, `frontend`, `stub`, `priority-medium`
**Epic:** De-Stub: Make Aspirational Features Real
**Estimated LoC:** ~420  (hard cap 700)

## Problem
In `frontend/src/features/Practice/screens/CreatePracticeWizard.tsx:354-372`, the `MODE_FORMS`
table maps `tallied_grounding` and `mindful_anchor` to `null`. Both modes ship a runtime **engine +
view** but have **no configurator form**, so the wizard falls through to a dead-end `NoticeView`
that says the feature "will ship with a configurator soon" and saves smart defaults verbatim.
Worse, the notice copy is hardcoded to **"Tallied grounding…"** and is shown for `mindful_anchor`
too — the **wrong feature name** for that mode.
**Current state:** §5.1 class **stub** (`2026-06-24_ADEPTHOOD_FULL_AUDIT.md` §6, row 9; marked
"Maybe" for ship). Treat as **ship-blocking for these two modes**: they are user-selectable in the
wizard, so a dead-end with a wrong label is a visible defect.

## Scope
**Covers:** building real configurator forms for both `tallied_grounding` and `mindful_anchor`
(wired into `MODE_FORMS`), and removing the dead-end `NoticeView` fallback for these two modes.
**Does NOT cover:** changing the runtime engines/views (they exist and work), the other modes'
forms, or the entry-step preset CTA (`audit-destub-02`). If the fallback `NoticeView` is still
needed for some genuinely unconfigurable future mode, keep it but make its message derive from the
mode (no hardcoded "Tallied grounding").

## Tasks
1. **Tallied-grounding form** — add `TalliedGroundingForm` editing its `ModeConfig` fields (match
   the engine/view's config shape; reuse the patterns in
   `configurator/forms/SenseGroundingForm.tsx`). Follow the
   stable-key guidance from §5.2 (no array-index keys). TDD: render the form, change each field,
   assert `onChange` emits the updated `ModeConfig`.
2. **Mindful-anchor form** — add `MindfulAnchorForm` for its `ModeConfig` fields. TDD as above.
3. **Wire the table** — set `MODE_FORMS.tallied_grounding` and `MODE_FORMS.mindful_anchor` to the
   new forms, so `ConfiguratorBody` renders a real form instead of the `null` → `NoticeView`
   branch. TDD: a test that selecting each mode in the wizard renders its form, not the "ships
   soon" notice.
4. **Fix the copy** — if any `NoticeView` fallback remains for other modes, derive its message from
   the selected mode's display name so `mindful_anchor` (or any mode) never shows "Tallied
   grounding". TDD: assert the notice (where still reachable) names the correct mode.

## Acceptance Criteria
- [ ] Selecting `tallied_grounding` in the wizard renders `TalliedGroundingForm`; editing fields
      updates the saved config.
- [ ] Selecting `mindful_anchor` renders `MindfulAnchorForm`; editing fields updates the saved
      config.
- [ ] Neither mode shows the dead-end "ships soon" notice; no surface shows the wrong feature name.
- [ ] Any remaining fallback notice derives its label from the selected mode.
- [ ] No existing tests break; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on --all-files.

## Files to Create/Modify
| File | Action |
|------|--------|
| `frontend/src/features/Practice/configurator/forms/TalliedGroundingForm.tsx` | Create |
| `frontend/src/features/Practice/configurator/forms/MindfulAnchorForm.tsx` | Create |
| `frontend/src/features/Practice/screens/CreatePracticeWizard.tsx` | Modify (wire forms; fix notice copy) |
| `frontend/src/features/Practice/configurator/__tests__/TalliedGroundingForm.test.tsx` | Create |
| `frontend/src/features/Practice/configurator/__tests__/MindfulAnchorForm.test.tsx` | Create |
| `frontend/src/features/Practice/screens/__tests__/CreatePracticeWizard.test.tsx` | Modify (renders-form, correct-label tests) |
