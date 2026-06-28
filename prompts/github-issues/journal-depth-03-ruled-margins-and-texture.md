# journal-depth-03: Add a ruled margin & page edge to the sheet

**Labels:** `frontend`, `ux`, `design`
**Epic:** [Give the Journal a floating-page depth & editorial polish](journal-depth-epic.md)
**Depends on:** [journal-depth-02](journal-depth-02-floating-writing-sheet.md) (the floated sheet exists)
**Estimated LoC:** ~120

## Problem

Issue 02 lifts the page, but the user's ask is also to feel like "writing on a
page **with some margins**." A floated sheet with no internal structure still
reads as a plain panel. A faint **margin rule** between the writing column and
the marginalia column — plus a barely-there lit edge on the sheet — is the
classic editorial cue that turns a panel into *a page*.

The two-column layout already exists: the writing column and the
`journal-margin-column` sit side by side on wide screens and stack on narrow
ones (`JournalEntry.styles.ts:53-61`, `JournalEntryScreen.tsx:584-621`).

## Scope

Add a faint vertical margin rule between the writing column and the marginalia
(wide screens) that becomes a horizontal rule when the marginalia stacks
underneath (narrow screens), plus a subtle lit edge on the sheet. Tokens only;
no behaviour changes.

## Tasks

### 1. Margin rule via the margin column's leading edge

In `JournalEntry.styles.ts`, give `marginColumn` a hairline leading rule and
make the narrow variant move it to the top:

```ts
marginColumn: {
  width: journalLayout.marginColumnWidth,
  paddingLeft: journalLayout.marginNoteGap,
  paddingVertical: spacing(3),
  borderLeftWidth: StyleSheet.hairlineWidth,
  borderLeftColor: colors.paper.hairline,
},
marginColumnNarrow: {
  width: '100%',
  paddingLeft: 0,
  borderLeftWidth: 0,
  // When the column stacks under the writing area, rule the top instead.
  borderTopWidth: StyleSheet.hairlineWidth,
  borderTopColor: colors.paper.hairline,
  paddingTop: spacing(2),
  marginTop: spacing(1),
},
```

The rule must read as a *page margin*, not a hard divider — `colors.paper.hairline`
at `StyleSheet.hairlineWidth` is intentionally faint. Do not darken it.

### 2. A lit edge on the sheet (optional polish, keep subtle)

Give the sheet from issue 02 a 1px top/side border in `colors.paper.sheetEdge`
so the lift catches a touch of light at the edge:

```ts
sheet: {
  /* …issue 02 props… */
  borderTopWidth: StyleSheet.hairlineWidth,
  borderLeftWidth: StyleSheet.hairlineWidth,
  borderRightWidth: StyleSheet.hairlineWidth,
  borderColor: colors.paper.sheetEdge,
},
```

Verify the border + rounded corners + shadow still render correctly together
(no double-border seams at the corners).

### 3. Confirm read-mode parity

Read mode (`ReadColumn`, `JournalEntryScreen.tsx:379-411`) uses the **same**
`writingColumn` / `marginColumn` styles, so the rule applies to both edit and
read modes automatically. Do not special-case it; just verify visually and in
tests.

## Tasks — tests

- Extend `JournalEntryScreen.test.tsx`: flatten the `journal-margin-column`
  style on a wide layout and assert `borderLeftWidth > 0` with
  `borderLeftColor === colors.paper.hairline`.
- Add a narrow-layout case (mock `useWindowDimensions` to width `< 600`) and
  assert the rule moves to the top (`borderTopWidth > 0`, `borderLeftWidth ===
  0`). Reuse the existing window-dimensions mocking pattern in the suite if
  present; otherwise mock `react-native`'s `useWindowDimensions`.

## Acceptance Criteria

- A faint vertical hairline separates the writing column from the marginalia on
  wide screens; it becomes a top hairline when the marginalia stacks on narrow
  screens.
- The sheet shows a subtle lit edge (`colors.paper.sheetEdge`) without seams or
  a heavy "boxed" look.
- The rule appears in both edit and read modes (shared styles).
- All existing Journal tests pass; the rule uses only tokenised values.
- `cd frontend && npm test && npm run lint && npx tsc --noEmit` pass.

## Files to Modify

| File | Action |
|------|--------|
| `frontend/src/features/Journal/JournalEntry.styles.ts` | Modify — margin rule + sheet edge |
| `frontend/src/features/Journal/__tests__/JournalEntryScreen.test.tsx` | Modify — wide/narrow rule assertions |
</content>
