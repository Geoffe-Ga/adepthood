# design-language-04: Warm grounds & soft elevation for cards/surfaces

**Labels:** `frontend`, `design`, `ux`, `priority-medium`
**Epic:** [Adopt a warm-editorial design language app-wide](design-language-warm-editorial-epic.md)
**Estimated LoC:** ~150
**Depends on:** 01 (semantic tokens + warm elevation).

## Problem

Screen backgrounds and cards across Habits, Practice, Course, and Map sit on
flat grey (`colors.background.primary #f8f8f8` / `card #ffffff`) with
neutral-black `shadows`. Against the new warm grounds this reads cold and
disconnected from the journal's lifted-paper feel.

## Scope

Migrate primary screen grounds and card surfaces from the grey chrome palette
to the semantic `surface.*` tokens, and replace neutral-black `shadows` on
cards/sheets with the warm `elevation`/`surfaceShadow` from issue 01. Do not
change layout structure or screen logic — this is a ground + elevation re-skin.

## Tasks

1. **Screen grounds:** swap `colors.background.primary` → `surface.canvas` on
   the root `SafeAreaView`/`ScrollView` of Habits, Practice, Course, Map, Auth.
2. **Cards / tiles:** swap `colors.background.card` → `surface.raised`; apply
   warm `surfaceShadow` (both iOS/web props and Android `elevation`); use
   `surface.hairline` for separators instead of grey `separator` where it sits
   on a warm ground.
3. **Map / stage surfaces:** keep `STAGE_COLORS` / `MAP_STAGE_COLORS` (they are
   semantic content colors), but set their *container* grounds/cards to the warm
   surfaces so the stage hues sit on paper, not grey.
4. **Mystical/glow accents:** keep `colors.mystical.*`; verify they still read
   on the warm grounds (adjust opacity only if needed, in tokens).
5. Verify text on every migrated ground still clears AA; add/adjust contrast
   tests where a screen asserts colors.

## Acceptance Criteria

- [ ] Habits, Practice, Course, Map, and Auth render on `surface.canvas`; cards
      use `surface.raised` with warm `surfaceShadow` — no flat `#f8f8f8`/black
      shadows remain on these primary surfaces.
- [ ] Stage colors and mystical accents are preserved and still legible/AA on
      the warm grounds.
- [ ] Shadows specify iOS/web props **and** Android `elevation`; asserted via
      `StyleSheet.flatten`.
- [ ] No inline hex / bare pixels; values from semantic tokens.
- [ ] All existing screen tests and testIDs pass.
- [ ] `cd frontend && npm test && npm run lint && npx tsc --noEmit` green;
      `pre-commit run --all-files` green.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Habits/Habits.styles.ts` | Modify (grounds/cards) |
| `frontend/src/features/Practice/**` styles | Modify |
| `frontend/src/features/Course/**` styles | Modify |
| `frontend/src/features/Map/**` styles + `stageData.ts` containers | Modify |
| Relevant `__tests__` | Modify (ground/shadow assertions) |
