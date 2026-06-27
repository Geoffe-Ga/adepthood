# practice-redesign-05: Disentangle the edit / adjust / duplicate affordances

**Labels:** `enhancement`, `frontend`, `ritual-practice`
**Epic:** [Practice frontend redesign](practice-redesign-epic.md)
**Depends on:** #02 (active-card header), #03 ("Change practice" exists).
**Estimated LoC:** ~150

## Problem

"Edit buttons edit the wrong thing." Three different actions all read like
"edit" and the user can't tell them apart:

- The gear ⚙︎ on the active card (`ActiveRitualSession.tsx:418-426`,
  `accessibilityLabel="Configure practice"`) opens `RitualConfiguratorSheet`,
  which edits a **per-user override** of the active practice's settings
  (`userPractices.customize`) — it does **not** edit the practice itself.
- `PracticeDetailScreen.tsx:330-335` "Customize a copy" creates a **brand-new
  practice** from this one.
- The configurator sheet header is generic, so once opened it's unclear it only
  affects *your* copy.

## Scope

Make the three verbs distinct and unambiguous in label and presentation. Copy /
labelling / minor layout only — no behaviour change to what each action does.

## Tasks

1. **Active card → "Adjust"**
   - In `ActiveRitualSession.tsx` `SessionCard` (lines 413-447), turn the bare
     gear glyph into a labelled control: visible text **"Adjust"** (with the gear
     as an adornment) and `accessibilityLabel="Adjust this practice's settings"`.
     It must not read as "edit the practice for everyone".

2. **Detail → "Duplicate & edit"**
   - In `PracticeDetailScreen.tsx`, rename the "Customize a copy" action
     (line 332, `testID="practice-detail-customize-copy"`) to **"Duplicate & edit"**
     and update its `accessibilityLabel`. Keep the existing
     `navigateToCopy` behaviour. Keep the existing owner-edit note/comment.

3. **Configurator header clarity**
   - In `RitualConfiguratorSheet.tsx`, make the sheet header state plainly that
     it adjusts **your** settings for this practice (e.g. title "Adjust your
     practice" / a one-line subtitle), so the override scope is obvious. The
     existing "Reset to default" control already communicates the override model —
     keep it.

4. **Distinct from "Change practice"**
   - Verify the #03 "Change practice" (switch) control and the new "Adjust"
     control are visibly different and not adjacent-and-identical in styling.

5. **Tests**
   - Update `ActiveRitualSession` / `PracticeScreen` tests for the "Adjust" label.
   - Update `PracticeDetailScreen.test.tsx` for "Duplicate & edit".
   - Update `RitualConfiguratorSheet.test.tsx` for the clarified header.

## Acceptance Criteria

- [ ] The active-card settings control reads "Adjust" and is labelled as editing *your* settings.
- [ ] The detail screen's copy action reads "Duplicate & edit".
- [ ] The configurator header makes the per-user-override scope obvious.
- [ ] "Switch", "Adjust", and "Duplicate & edit" are three visibly distinct affordances.
- [ ] `npm test`, `npx tsc --noEmit`, `npm run lint` green; coverage unchanged.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Practice/components/ActiveRitualSession.tsx` | Modify |
| `frontend/src/features/Practice/screens/PracticeDetailScreen.tsx` | Modify |
| `frontend/src/features/Practice/configurator/RitualConfiguratorSheet.tsx` | Modify |
| `frontend/src/features/Practice/screens/__tests__/PracticeDetailScreen.test.tsx` | Modify |
| `frontend/src/features/Practice/configurator/__tests__/RitualConfiguratorSheet.test.tsx` | Modify |
| `frontend/src/features/Practice/__tests__/PracticeScreen.test.tsx` | Modify |

## Constraints

- Frontend only. Copy + labelling + light layout; do not change what any action does.
- Do not touch the configurator forms (`configurator/forms/`) or the
  `userPractices.customize` call.
- Owner-only Edit/Delete remains out of scope (blocked by the backend dropping
  the submitter id, per the existing `PracticeDetailScreen` comment).
