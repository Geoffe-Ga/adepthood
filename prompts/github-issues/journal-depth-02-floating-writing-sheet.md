# journal-depth-02: Float the writing surface as a paper sheet

**Labels:** `frontend`, `ux`, `design`
**Epic:** [Give the Journal a floating-page depth & editorial polish](journal-depth-epic.md)
**Depends on:** [journal-depth-01](journal-depth-01-elevation-tokens.md) (desk + `paperShadow` + sheet metrics)
**Estimated LoC:** ~160

## Problem

The writing page paints its background and its content the same colour, so it
looks flat (see the epic's "What flat means today"). Concretely:

- `frontend/src/features/Journal/JournalEntry.styles.ts:28-31` — `safeArea`
  uses `colors.paper.background`, identical to the page content's ground.
- `frontend/src/features/Journal/JournalEntry.styles.ts:32-41` — `page` sits
  directly on that ground; no elevated surface, shadow, or page edge.

We want the writing area to read as a **lighter sheet of paper floating above a
deeper desk**, capped to a comfortable reading width and centred, with the
desk visible around its edges.

## Scope

Restructure the `JournalPage` render tree into **desk → sheet → page**, move
the width cap / centring onto the sheet, and recolour the desk. Pure
presentation: no behaviour, prop, or data-flow changes. Preserve the
`journal-page` testID and its `paddingBottom: RESONANCE_BUTTON_CLEARANCE`.

## Tasks

### 1. Recolour the desk and add sheet styles

In `JournalEntry.styles.ts`:

```ts
safeArea: {
  flex: 1,
  backgroundColor: colors.paper.desk, // the deeper "desk" ground (issue 01)
},
/** Padded desk so the deeper ground shows as a border around the lifted sheet. */
desk: {
  flex: 1,
  paddingHorizontal: journalSheet.deskPaddingH,
  paddingTop: journalSheet.deskPaddingTop,
},
/** The floating paper sheet: lighter ground, soft warm shadow, rounded top. */
sheet: {
  flex: 1,
  width: '100%',
  maxWidth: journalLayout.pageMaxWidth + journalLayout.marginColumnWidth,
  alignSelf: 'center',
  backgroundColor: colors.paper.background,
  borderTopLeftRadius: journalSheet.cornerRadius,
  borderTopRightRadius: journalSheet.cornerRadius,
  ...paperShadow.sheet,
},
sheetNarrow: { maxWidth: '100%' },
```

Then update `page` to **drop** `maxWidth`/`alignSelf` (now on the sheet) while
**keeping** `flexDirection: 'row'`, `paddingHorizontal:
journalLayout.pageHorizontalPadding`, and crucially
`paddingBottom: RESONANCE_BUTTON_CLEARANCE`.

### 2. Wrap the page tree in desk → sheet

In `JournalEntryScreen.tsx`, the `JournalPage` component
(`JournalEntryScreen.tsx:574-624`) currently returns a single
`<View style={[styles.page, …]} testID="journal-page">`. Wrap it:

```tsx
return (
  <View style={styles.desk}>
    <View style={[styles.sheet, narrow && styles.sheetNarrow]}>
      <View style={[styles.page, narrow && styles.pageNarrow]} testID="journal-page">
        {/* …existing WritingColumn/ReadColumn + margin column, unchanged… */}
      </View>
    </View>
  </View>
);
```

`narrow` already exists in `JournalPage` via `useWindowDimensions().width <
NARROW_BREAKPOINT`. The floating "Get Resonance" button, modal, and dialog stay
as siblings of `JournalPage` under the `SafeAreaView` — do not move them.

### 3. Verify the rounded corner doesn't clip content

The sheet rounds only its **top** corners; the bottom runs under the floating
button (that's the intended look). Do not add `overflow: 'hidden'` to the
sheet — on iOS it would clip the shadow. Content never reaches the rounded
corners because of the page's `pageHorizontalPadding` + the column's vertical
padding, so no clipping is needed.

## Tasks — tests

- Extend `JournalEntryScreen.test.tsx`: assert a new node (e.g. `testID="journal-sheet"`,
  add it to the sheet `View`) flattens to `backgroundColor === colors.paper.background`
  and carries a non-zero `shadowRadius`/`elevation`.
- Assert `safeArea` (or the screen root) uses `colors.paper.desk`.
- **Keep the existing assertion** that `journal-page` `paddingBottom ===
  RESONANCE_BUTTON_CLEARANCE` green — this is the regression guard.

## Acceptance Criteria

- The writing page renders as a lighter sheet on a visibly deeper desk ground,
  with the desk showing as a margin on the left, right, and top.
- The sheet has rounded top corners and the warm `paperShadow.sheet`.
- The sheet caps width at `pageMaxWidth + marginColumnWidth` and is centred on
  wide screens; on narrow (`< 600`) screens it goes edge-to-edge.
- `journal-page` keeps its testID and `paddingBottom ===
  RESONANCE_BUTTON_CLEARANCE`; all existing `JournalEntryScreen` tests pass.
- No magic numbers — desk/sheet metrics come from issue-01 tokens.
- `cd frontend && npm test && npm run lint && npx tsc --noEmit` pass.

## Files to Modify

| File | Action |
|------|--------|
| `frontend/src/features/Journal/JournalEntry.styles.ts` | Modify — desk/sheet styles; trim `page` |
| `frontend/src/features/Journal/JournalEntryScreen.tsx` | Modify — wrap `JournalPage` in desk → sheet; add `journal-sheet` testID |
| `frontend/src/features/Journal/__tests__/JournalEntryScreen.test.tsx` | Modify — assert sheet/desk styling; keep clearance test |
</content>
