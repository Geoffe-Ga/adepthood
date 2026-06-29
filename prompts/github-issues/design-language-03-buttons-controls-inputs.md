# design-language-03: Restyle shared buttons, controls & inputs

**Labels:** `frontend`, `design`, `ux`, `priority-medium`
**Epic:** [Adopt a warm-editorial design language app-wide](design-language-warm-editorial-epic.md)
**Estimated LoC:** ~150
**Depends on:** 01 (semantic tokens), 02 (type ramp).

## Problem

Interactive chrome — primary/secondary buttons, icon buttons, text inputs,
toggles — is styled per-feature against the grey palette (`uiType.button` plus
inline styles in feature `*.styles.ts` files; there is no single shared
`Button` primitive yet). The result is inconsistent and cold against the new
warm grounds.

## Scope

Restyle the common interactive controls to the warm-editorial language using
the semantic `accent`/`surface`/`ink` tokens and the type ramp. Where a shared
primitive already exists, restyle it; where controls are inline per-feature,
restyle the highest-traffic ones (Auth buttons/inputs, Habits primary actions,
the journal resonance button) to the shared token vocabulary. Prefer extracting
a shared `Button`/`TextField` primitive if it reduces duplication, but that is
optional — the deliverable is consistent *appearance*, not a refactor.

## Tasks

1. **Primary / secondary / tertiary buttons:** terracotta `accent` fill for
   primary; warm-outline/ghost for secondary; text-only for tertiary. Pressed +
   disabled states from `accent.pressed` / muted tokens. Label uses the type
   ramp's `label` role. Keep `SPACING.buttonV` and `touchTarget.minimum` (44dp).
2. **Icon buttons / touchables:** warm hit states, 44dp hit-area (or `hitSlop`),
   focus-visible ring where the platform supports it.
3. **Text inputs / fields:** warm ground (`surface.raised`/`sunken`), hairline
   border, `ink` text, `ink.muted` placeholder, terracotta focus accent. Reuse
   the existing `bevel` tokens for recessed fields where already used.
4. **Banners / chips** (destructive/success): keep semantics, retone to sit on
   warm grounds without breaking the asserted contrast.
5. Honour `prefers-reduced-motion` for any press animation.

## Acceptance Criteria

- [ ] Primary/secondary/tertiary buttons, icon buttons, and inputs render in the
      warm-editorial language across Auth + Habits + Journal entry points.
- [ ] All interactive controls meet 44dp (`touchTarget.minimum`) and AA contrast
      (text ≥ 4.5:1; accent/borders ≥ 3:1 per SC 1.4.11) on their ground.
- [ ] No inline hex / bare pixels — values come from the semantic tokens + ramp.
- [ ] Every existing testID and press/submit behaviour is preserved; existing
      component tests pass.
- [ ] `cd frontend && npm test && npm run lint && npx tsc --noEmit` green;
      `pre-commit run --all-files` green.

## Files to Create/Modify

| File | Action |
|------|--------|
| Shared `Button`/`TextField` primitive (extract if helpful) | **Create** (optional) |
| `frontend/src/features/Auth/**` button/input styles | Modify |
| `frontend/src/features/Habits/Habits.styles.ts` | Modify (control styles) |
| Journal resonance button styles | Modify |
| Relevant `__tests__` | Modify (state/contrast assertions) |
