# custom-practices-07: Practice catalog browse screen + Create-custom flow

**Labels:** `enhancement`, `ritual-practice`, `frontend`
**Epic:** [Customizable practices](custom-practices-epic.md)
**Depends on:** custom-practices-05 (random interval bell), custom-practices-06 (card meditation). All existing mode forms should be in place.
**Estimated LoC:** ~450

## Role

You are a React Native engineer building the highest-leverage UX of the epic: the global Practice catalog and the create-custom flow that funnels into it. You apply the epic-level UX guard-rails to prevent bloat with 11 modes.

## Goal

Add a top-level **Practice catalog** screen where users browse all visible practices (presets + their own drafts + imported drafts), filter by stage and mode, and tap **+ Create** to author a new custom practice. The create flow guides them through: pick mode → configure → name + (optional) stage assignment → save.

## Context

Today, the only way to pick a practice for a stage is the per-stage `PracticeSelector`. There's no global catalog and no way to create a new practice through the app (the `POST /practices` API exists but has no UI). After this issue:
- The catalog is reachable from a new top-level nav entry (Bottom tab or drawer item)
- The create flow reuses **every existing per-mode form** under `frontend/src/features/Practice/configurator/forms/` (do not rebuild any of these)
- Stage assignment uses the existing `POST /user-practices` API

## UX Guard-rails (apply ALL of these)

The epic-level constraint: **11 modes is bloat unless mitigated.** This screen must:

1. **Categorize modes** in the picker, not a flat list:
   - **Timers:** `meditation_timer`, `count_up`
   - **Bells:** `metronome`, `interval_bell`, `random_interval_bell`
   - **Grounding:** `sense_grounding`, `tallied_grounding`, `mindful_anchor`
   - **Reflection:** `tarot`, `card_meditation`
   - **Movement:** `rep_counter`
   - Each category renders as a card with an icon, one-line description, and the modes inside.
2. **Start from a preset** is the recommended path. The create flow opens with two cards: **Start from a preset** (browse the catalog, pick one, "Customize a copy") and **Start from scratch** (mode picker).
3. **Progressive disclosure** on each mode form (already applied in 05 + 06; ensure all existing forms also have an Advanced toggle — if any don't, add one with sensible defaults).
4. **One screen per phase**: Catalog → Detail → Create wizard (3 steps). No mega-form.
5. **Smart defaults** on every mode form so a user can submit immediately after pick.

## Tasks

1. **Catalog screen** at `frontend/src/features/Practice/screens/PracticeCatalogScreen.tsx`:
   - Top: search bar (matches name + description), filter chips (stage, mode category)
   - Sections (collapsible):
     - **Presets** — `submitted_by_user_id IS NULL` (group by stage)
     - **My drafts** — practices I submitted
     - **Imported** — drafts I received via share link (distinguished by a metadata field; add `imported_from_token: str | None` on `Practice` in a tiny extension PR or store a hint on the create call)
   - Each row: name, mode badge, stage chip, "duration · default 5 min" subtitle
   - Tap a row → `PracticeDetailScreen`
   - FAB / header button: **+ Create**

2. **Practice detail screen** at `frontend/src/features/Practice/screens/PracticeDetailScreen.tsx`:
   - Read-only summary: name, description, instructions, mode, mode_config (rendered via the appropriate per-mode summary helper)
   - Actions: **Use for stage…** (opens a stage picker, calls `POST /user-practices`), **Customize a copy** (opens the create flow with this practice's mode_config pre-filled), **Share** (sub-issue 03), **Edit** (only if I own it), **Delete** (only if I own it and it's unapproved)

3. **Create-custom wizard** at `frontend/src/features/Practice/screens/CreatePracticeWizard.tsx`:
   - **Step 0** — Entry choice: **Start from a preset** (jumps to catalog with a "select to customize" CTA) or **Start from scratch** (mode category picker)
   - **Step 1** — Mode picker: categorized cards (per Guard-rails #1), tap a mode → step 2
   - **Step 2** — Configurator: renders the existing form for the chosen mode (route via the same dispatch table the configurator uses). Validates with smart defaults already filled.
   - **Step 3** — Metadata + assignment: name (required, 1..120), description (optional, ≤1000), instructions (optional, ≤2000), default_duration_minutes (auto-suggested from config), stage_number (optional radio: leave for later / assign to stage N for any unlocked stage)
   - Submit: `POST /practices`. If stage was selected, also `POST /user-practices` to make it active for that stage. On success, navigate to the new practice's detail screen.

4. **Mode picker component** at `frontend/src/features/Practice/components/ModePicker.tsx`:
   - Pure data → UI, no state. Takes `onSelect(mode: PracticeMode)`. Renders the 5 categories with their modes as tappable rows.
   - Each mode entry has: icon (Ionicons or similar), label, one-line description, optional "New" tag for `tallied_grounding`, `mindful_anchor`, `random_interval_bell`, `card_meditation`

5. **Navigation wiring**:
   - Add Practice catalog as a top-level bottom-tab entry (or drawer item — match the existing nav style)
   - Adjust `frontend/src/navigation/` accordingly

6. **API client extension** at `frontend/src/api/practices.ts`:
   - Ensure `practices.list({ stage?, mode?, owner? })` supports the filters the catalog needs. Add to the existing client if not present.
   - Confirm `userPractices.create({ practice_id, stage_number })` is wired

7. **Tests**:
   - `PracticeCatalogScreen.test.tsx`: renders Presets/My drafts/Imported sections, search filters by name, stage chip filters by stage_number
   - `PracticeDetailScreen.test.tsx`: renders mode-config summary, "Use for stage" opens picker, "Customize a copy" opens wizard with pre-filled config
   - `CreatePracticeWizard.test.tsx`: step navigation, mode picker routes to correct form, submit calls `practices.create` and (if stage chosen) `userPractices.create`
   - `ModePicker.test.tsx`: renders all 5 categories, tapping a mode calls `onSelect` with the right value, "New" tag appears on the four new modes

## Acceptance Criteria

- [ ] `npm test` green
- [ ] `npx tsc --noEmit` passes
- [ ] Catalog is reachable from a top-level nav entry
- [ ] Manual smoke: tap **+ Create** → pick **Bells → Random Interval Bell** → adjust min/max → name "Awareness bells" → assign to my current stage → start session immediately
- [ ] Manual smoke: tap a preset → **Customize a copy** → modify → save → appears under My drafts
- [ ] Existing per-stage `PracticeSelector` and `PracticeSwitcherSheet` flows still work unchanged

## Files

| File | Action |
|------|--------|
| `frontend/src/features/Practice/screens/PracticeCatalogScreen.tsx` | **Create** |
| `frontend/src/features/Practice/screens/PracticeDetailScreen.tsx` | **Create** |
| `frontend/src/features/Practice/screens/CreatePracticeWizard.tsx` | **Create** |
| `frontend/src/features/Practice/components/ModePicker.tsx` | **Create** |
| `frontend/src/features/Practice/screens/__tests__/PracticeCatalogScreen.test.tsx` | **Create** |
| `frontend/src/features/Practice/screens/__tests__/PracticeDetailScreen.test.tsx` | **Create** |
| `frontend/src/features/Practice/screens/__tests__/CreatePracticeWizard.test.tsx` | **Create** |
| `frontend/src/features/Practice/components/__tests__/ModePicker.test.tsx` | **Create** |
| `frontend/src/navigation/` (root nav) | Modify |
| `frontend/src/api/practices.ts` | Possibly modify |

## Constraints

- **Reuse every existing form** under `frontend/src/features/Practice/configurator/forms/`. Do not duplicate any form logic. If an existing form lacks progressive disclosure, add an "Advanced" toggle to it in this PR (small per-form change, ≤20 LoC each)
- Stage assignment uses `POST /user-practices`, not a new endpoint
- Apply ALL UX guard-rails listed above. A reviewer should be able to point at the screen and see each guard-rail in action
- Imported practices have no special API today; if you need to distinguish them, add `imported_from_share_token: str | None` to `Practice` in a small extension within this PR (or thread it from `practice_share.py` in sub-issue 03 — coordinate during review)
- Accessibility: every form field has `accessibilityLabel`; the wizard's step indicator is announced; mode picker rows are radio-like (`accessibilityRole="radio"`)
