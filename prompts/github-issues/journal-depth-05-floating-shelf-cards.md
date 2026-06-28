# journal-depth-05: Float the shelf entries as paper cards

**Labels:** `frontend`, `ux`, `design`
**Epic:** [Give the Journal a floating-page depth & editorial polish](journal-depth-epic.md)
**Depends on:** [journal-depth-01](journal-depth-01-elevation-tokens.md) (desk + `paperShadow`)
**Estimated LoC:** ~170

## Problem

The shelf — the journal's landing list — is as flat as the writing page was.
`JournalShelf.styles.ts` paints `safeArea` with `colors.paper.background`
(`:7-10`) and renders each entry as a hairline-separated **row**
(`card`, `:33-38`) on that single flat ground. After issues 02–04 the writing
page floats but the shelf still looks flat, breaking the feature's cohesion.
The shelf entries are conceptually "pages on a shelf" — they should read as
**lifted paper cards on the same desk ground.**

## Scope

Recolour the shelf to the desk ground and turn each entry row into a floated
paper card; give the weekly-prompt card matching depth. Preserve the shelf's
testIDs, the `new entry` CTA behaviour, the empty/error states, and list
scrolling. Presentation only.

## Tasks

### 1. Desk ground + lifted entry cards

In `JournalShelf.styles.ts`:

```ts
safeArea: {
  flex: 1,
  backgroundColor: colors.paper.desk, // shared desk ground (issue 01)
},
listContent: {
  paddingHorizontal: SPACING.lg,
  paddingTop: SPACING.md,
  paddingBottom: SPACING.xxl,
  flexGrow: 1,
},
card: {
  minHeight: touchTarget.minimum, // import touchTarget; was a bare 44
  paddingVertical: SPACING.md,
  paddingHorizontal: SPACING.lg,
  marginBottom: SPACING.md,
  borderRadius: BORDER_RADIUS.md,
  backgroundColor: colors.paper.background, // the lifted page card
  ...paperShadow.card,
  // Remove the old borderBottom hairline — separation now comes from the
  // gap + shadow between floated cards.
},
```

Drop `card`'s `borderBottomWidth`/`borderBottomColor`. Verify `cardTitleRow`,
`cardTitle`, `cardDate`, `cardExcerpt` still lay out correctly inside the padded
card (`:39-58`).

### 2. Give the weekly-prompt card matching depth

`promptCard` (`:76-84`) is a flat `backgroundAlt` block with a coloured left
bar. Keep its identity (the accent bar marks it as the prompt) but lift it onto
the desk consistently:

```ts
promptCard: {
  marginHorizontal: SPACING.lg,
  marginTop: SPACING.lg,
  padding: SPACING.lg,
  borderRadius: BORDER_RADIUS.md,
  backgroundColor: colors.paper.background,
  borderLeftWidth: 3,
  borderLeftColor: colors.marginalia.theme,
  ...paperShadow.card,
},
```

### 3. Keep the CTA and states intact

`newEntry` (`:19-27`) stays the solid primary button — it's chrome, not a
paper card; leave its fill. Confirm the empty (`emptyWrap`/`emptyText`) and
error (`emptyError`) states still centre correctly on the new desk ground and
remain AA (`inkSoft`/`danger` on `colors.paper.desk` — verify >= 4.5:1; if
`danger` on `desk` is borderline, keep error text on a small `background`
chip rather than darkening the desk).

## Tasks — tests

- Extend `JournalShelfScreen.test.tsx`: flatten an entry card's style and
  assert `backgroundColor === colors.paper.background`, a non-zero
  `shadowRadius`/`elevation`, and **no** `borderBottomWidth`.
- Assert `safeArea`/root uses `colors.paper.desk`.
- Confirm existing shelf tests (entry list render, tap → navigate, empty/error,
  prompt card) still pass.

## Acceptance Criteria

- Shelf entries render as lifted paper cards on the deeper desk ground, spaced
  by gaps rather than hairline dividers.
- The weekly-prompt card shares the floated treatment while keeping its accent
  bar identity.
- The "New entry" CTA, empty state, and error state are unchanged in behaviour
  and remain AA-legible on the desk ground.
- All existing shelf tests pass; tokens only, no magic numbers (replace the
  bare `44` with `touchTarget.minimum`).
- `cd frontend && npm test && npm run lint && npx tsc --noEmit` pass.

## Files to Modify

| File | Action |
|------|--------|
| `frontend/src/features/Journal/JournalShelf.styles.ts` | Modify — desk ground + floated cards |
| `frontend/src/features/Journal/JournalShelfScreen.tsx` | Modify only if markup changes are needed for spacing |
| `frontend/src/features/Journal/__tests__/JournalShelfScreen.test.tsx` | Modify — assert card depth + desk ground |
</content>
