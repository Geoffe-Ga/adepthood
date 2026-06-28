# journal-depth-04: Lift the marginalia notes off the page

**Labels:** `frontend`, `ux`, `design`
**Epic:** [Give the Journal a floating-page depth & editorial polish](journal-depth-epic.md)
**Depends on:** [journal-depth-01](journal-depth-01-elevation-tokens.md) (`paperShadow.card`)
**Estimated LoC:** ~110

## Problem

`MarginNote` cards are flat fills (`colors.paper.backgroundAlt`) with a coloured
left bar (`MarginNote.tsx:47-55`). Once the page itself floats (issue 02), flat
notes sitting on it look pasted-on rather than *pinned to the margin*. Giving
each note a gentle lift makes the marginalia feel like physical slips laid on
the page — reinforcing the epic's tactile, layered language.

## Scope

Add a soft shadow and a slightly more refined card treatment to `MarginNote`,
keeping its kind accent, stale state, and `margin-note-<id>` testID intact.
Presentation only.

## Tasks

### 1. Lift the card with `paperShadow.card`

In `MarginNote.tsx`, apply the issue-01 card shadow and a small radius bump so
the note reads as a lifted slip on the page:

```ts
card: {
  minHeight: touchTarget.minimum,
  padding: SPACING.md,
  borderRadius: BORDER_RADIUS.md,
  backgroundColor: colors.paper.background, // sits a touch above the page,
                                            // lifted by the shadow (was backgroundAlt)
  borderLeftWidth: 3,
  borderLeftColor: colors.paper.hairline,
  ...paperShadow.card,
},
```

Note the ground change from `backgroundAlt` → `background`: the *shadow* now
does the separation, so the card can match the page ground and still read as
lifted (cleaner than a flat tinted block). Keep the 3px left bar — issue 04b
below makes it the kind accent.

### 2. Make the left bar carry the kind accent

Today the kind colour is only on the `kind` label text
(`MarginNote.tsx:35`). Tie the card's left bar to the same
`colors.marginalia[note.kind]` so each note is colour-coded at a glance:

```tsx
<TouchableOpacity
  style={[
    styles.card,
    { borderLeftColor: colors.marginalia[note.kind] },
    isStale && styles.cardStale,
  ]}
  /* …unchanged… */
>
```

`colors.marginalia` accents are all AA on the paper ground (asserted in
`editorialTokens.test.ts:48-58`), so this is safe.

### 3. Keep the stale state legible

`cardStale` dims to `opacity: 0.55` (`MarginNote.tsx:56-58`). Confirm the
shadow + dim still read correctly (a dimmed-but-lifted slip is fine). Do not
remove the stale caption or its testID.

## Tasks — tests

- Extend `MarginNote.test.tsx`: flatten the card style and assert a non-zero
  `shadowRadius`/`elevation` and `borderLeftColor === colors.marginalia[kind]`
  for at least two kinds (e.g. `theme`, `connection`).
- Assert the existing `margin-note-<id>` and stale testIDs/labels still render.

## Acceptance Criteria

- Margin notes are visibly lifted off the page with the warm `paperShadow.card`.
- Each note's left bar is its kind accent colour (theme/connection/symbol).
- Stale notes still dim and still show their "passage changed" caption.
- All existing `MarginNote` tests pass; tokens only, no magic numbers.
- `cd frontend && npm test && npm run lint && npx tsc --noEmit` pass.

## Files to Modify

| File | Action |
|------|--------|
| `frontend/src/features/Journal/MarginNote.tsx` | Modify — card shadow + kind-accent left bar |
| `frontend/src/features/Journal/__tests__/MarginNote.test.tsx` | Modify — assert shadow + accent |
</content>
