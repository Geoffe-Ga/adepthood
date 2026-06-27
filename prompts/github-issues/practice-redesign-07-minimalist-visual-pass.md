# practice-redesign-07: Minimalist visual pass on the Practice surfaces

**Labels:** `enhancement`, `frontend`, `ritual-practice`
**Epic:** [Practice frontend redesign](practice-redesign-epic.md)
**Depends on:** #04, #05, #06 (IA, affordances, and copy are settled).
**Estimated LoC:** ~200

## Problem

Even after the IA and copy fixes, the Practice surfaces still *feel* busy:
card-in-card nesting, heavy shadows, and inconsistent spacing make the screen
"convey less with more." The redesign's aesthetic goal is the opposite — convey
more with less.

Current state:
- `ActiveRitualSession.tsx` wraps the session in a shadowed card
  (`styles.card`, lines 897-904, `shadows.medium`) that sits inside the
  screen's own padded scroll view — a card inside a frame.
- `PracticeScreen`, `PracticeCatalogScreen`, and `PracticeDetailScreen` each
  apply their own ad-hoc spacing and `shadows.small` on most rows/cards.

## Scope

A visual-only pass: flatten unnecessary nesting, lighten/auteur the shadow use,
make spacing consistent against the token scale, and establish a calm
typographic hierarchy. No new behaviour, no new strings, no layout that changes
what's on screen — just how densely it reads.

## Tasks

1. **Flatten the active screen**
   - Reduce the card-in-card nesting in `ActiveRitualSession.tsx` /
     `PracticeScreen.tsx`: prefer a single calm surface over a shadowed card
     floating inside a padded frame. Use whitespace and a hairline divider
     instead of stacked shadows where it reads cleaner.

2. **Consistent spacing + hierarchy**
   - Align padding/margins on the Practice, Catalog, and Detail screens to the
     `SPACING` scale in `design/tokens.ts` (no off-scale literals). One clear
     heading per screen; secondary text in `text.secondaryAccessible`; avoid
     more than two type weights per surface.

3. **Restrained shadows + radii**
   - Standardise on one elevation treatment per surface type (e.g. list rows
     share one shadow token; the screen background carries none). Pull radii from
     `BORDER_RADIUS`.

4. **Touch targets + a11y unaffected**
   - Keep every interactive element ≥ `touchTarget.minimum` and its
     `accessibilityRole`/`accessibilityLabel` intact.

5. **Tests**
   - Where tests assert styles, update them to the new named style objects
     (named-style assertions, not snapshot churn). Add/keep assertions that key
     tappables still meet the 44dp minimum.

## Acceptance Criteria

- [ ] The active Practice screen no longer nests a shadowed card inside a padded frame.
- [ ] Spacing, radii, and shadows on Practice/Catalog/Detail come from `design/tokens.ts` (no off-scale literals).
- [ ] No behaviour or copy changes; only visual density.
- [ ] Touch targets and accessibility labels are preserved.
- [ ] `npm test`, `npx tsc --noEmit`, `npm run lint` green; coverage unchanged.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Practice/PracticeScreen.tsx` | Modify |
| `frontend/src/features/Practice/components/ActiveRitualSession.tsx` | Modify |
| `frontend/src/features/Practice/screens/PracticeCatalogScreen.tsx` | Modify |
| `frontend/src/features/Practice/screens/PracticeDetailScreen.tsx` | Modify |
| `frontend/src/features/Practice/**/__tests__/*` | Modify (style assertions) |

## Constraints

- Frontend only. Visual/style changes; do not alter behaviour, navigation, or copy.
- Every value comes from `design/tokens.ts`. No magic numbers, no hard-coded colours.
- Prefer named-style assertions over snapshots; do not weaken or delete tests to
  pass — update them to the new styles.
