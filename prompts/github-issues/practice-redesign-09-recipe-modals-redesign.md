# practice-redesign-09: Minimalist redesign of the recipe-library modals

**Labels:** `enhancement`, `frontend`, `ritual-practice`
**Epic:** [Practice frontend redesign](practice-redesign-epic.md)
**Depends on:** #07 (visual language).
**Estimated LoC:** ~250

## Problem

The recipe library (reached from the configurator's "Browse recipe library →"
for grounding modes) is a deep but high-friction surface that hasn't had the
redesign treatment: dense rows, multiple similarly-styled per-row actions, and a
long step editor. For an end-to-end minimalist sweep it must match the rest of
Practice.

Current state:
- `frontend/src/features/Practice/recipes/RecipePickerModal.tsx`: header "Recipe
  library" (line 274), "+ New" (283), "Close" (292); rows expose "Use this"
  (363), "Edit a copy" (418, system recipes), "Edit" (428, personal), "Delete"
  (433) — four actions per row, visually crowded.
- `frontend/src/features/Practice/recipes/RecipeEditorModal.tsx`: "New recipe" /
  "Edit recipe" (140), Cancel (422), Save (429), name (449), description (471),
  rounds (491), repeating step cards (542) with reorder ↑/↓ (659-667), "Remove"
  (670), "+ Add step" (566).

## Scope

A minimalist visual + interaction pass over the two recipe modals only. Same
behaviour and the same `practiceRecipes` calls (`apply`, `create`, `update`,
`remove`); cleaner layout, calmer per-row action set, consistent tokens. The
recipe data model, `TagPicker`, and `SearchableDropdown` internals are unchanged.

## Tasks

1. **Picker rows** — give each recipe row one clear primary action ("Use this")
   and collapse the secondary actions (Edit / Edit a copy / Delete) into a quiet
   secondary affordance (e.g. an overflow / inline-secondary group) so a row
   isn't four equal buttons. Keep the "System" badge and the summary line (use
   #06's helper where a duration/count is shown).
2. **Editor layout** — group name/description/rounds at the top, then the step
   list as calm cards with the reorder + remove controls de-emphasised until
   focused. "+ Add step" is the one primary add action.
3. **Visual consistency** — spacing, radii, shadows, and type from
   `design/tokens.ts`, matching the #07 surfaces (the modals should feel like the
   same app as the redesigned screens).
4. **Tests** — update `recipes/__tests__/RecipePickerModal.test.tsx` and
   `recipes/__tests__/RecipeEditorModal.test.tsx` for the new action layout and
   named styles; assert every action keeps its `accessibilityRole`/`accessibilityLabel`.

## Acceptance Criteria

- [ ] Recipe rows lead with one primary "Use this" action; secondary actions are de-emphasised, not four equal buttons.
- [ ] The editor groups metadata then steps, with reorder/remove de-emphasised; "+ Add step" is the single add affordance.
- [ ] Spacing/colour/radii come from `design/tokens.ts` and match the #07 language.
- [ ] No behaviour change: the same `practiceRecipes` calls fire.
- [ ] `npm test`, `npx tsc --noEmit`, `npm run lint` green; coverage unchanged.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Practice/recipes/RecipePickerModal.tsx` | Modify |
| `frontend/src/features/Practice/recipes/RecipeEditorModal.tsx` | Modify |
| `frontend/src/features/Practice/recipes/__tests__/RecipePickerModal.test.tsx` | Modify |
| `frontend/src/features/Practice/recipes/__tests__/RecipeEditorModal.test.tsx` | Modify |

## Constraints

- Frontend only. Do not change the recipe data model, the `practiceRecipes` API
  calls, or `TagPicker` / `SearchableDropdown` internals.
- All design constants from `design/tokens.ts`; tap targets ≥44dp; a11y preserved.
- Reuse #06's shared helper for any duration/count copy; no new phrasings.
