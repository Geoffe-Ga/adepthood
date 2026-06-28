# journal-depth-01: Add editorial elevation tokens (desk ground + paper shadow)

**Labels:** `frontend`, `design`, `ux`
**Epic:** [Give the Journal a floating-page depth & editorial polish](journal-depth-epic.md)
**Depends on:** None — this is the critical-path foundation for issues 02–06
**Estimated LoC:** ~120

## Problem

The journal can't *float* anything because there is no token for the surface a
page would float **above**, and no shadow tuned to the warm paper palette.
Today `colors.paper` (`frontend/src/design/tokens.ts:121-128`) has only the
page ground (`background` `#faf6ef`) and a slightly warmer `backgroundAlt`
(`#f3ecdf`); the only shadows (`tokens.ts:274-303`) are neutral-black and
sized for grey app chrome. Issues 02–05 all need a deeper "desk" colour and a
soft, warm, downward shadow — so those values must exist in the single source
of truth first.

## Scope

Add the depth primitives — and *only* the primitives — to `tokens.ts`, with
tests. No component changes in this issue.

## Tasks

### 1. Add a "desk" ground to the paper palette (TDD)

In `colors.paper`, add a deeper, warmer ground the writing sheet will rest on:

```ts
paper: {
  background: '#faf6ef',
  backgroundAlt: '#f3ecdf',
  // The deeper, warmer "desk" the writing sheet floats above. A step darker
  // than `background` (relative luminance ~0.79 vs ~0.92) so the lighter sheet
  // reads as lifted; the warm shadow below does the rest of the depth cue.
  desk: '#e7dcc8',
  // Faint top/side edge for the lifted sheet — slightly lighter than `hairline`
  // so the sheet's border reads as a lit paper edge, not a divider.
  sheetEdge: '#efe7d8',
  ink: '#2b2620',
  inkSoft: '#5a5046',
  hairline: '#e3dccd',
  anchorHighlight: '#f0e3c2',
},
```

`colors.paper` is asserted with `arrayContaining` (`editorialTokens.test.ts:27-38`),
so adding keys is safe. Extend that test to assert the new `desk` and
`sheetEdge` keys are present.

### 2. Add a warm "paper" elevation shadow

Add an editorial shadow alongside `shadows` (do **not** mutate the existing
neutral ones — other features depend on them). Ink-tinted, soft, downward:

```ts
/**
 * Soft, warm, downward shadow for lifting paper surfaces (the journal sheet,
 * shelf cards, margin notes) off the desk ground. Ink-tinted rather than pure
 * black so the lift reads as paper-on-desk, not card-on-glass. iOS/web use the
 * shadow* props; Android uses `elevation`.
 */
export const paperShadow = {
  sheet: {
    shadowColor: colors.paper.ink,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.14,
    shadowRadius: 20,
    elevation: 8,
  },
  card: {
    shadowColor: colors.paper.ink,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 6,
    elevation: 3,
  },
} as const;
```

### 3. Add sheet layout metrics — without breaking the exact-keys test

`editorialTokens.test.ts:60-72` asserts `Object.keys(journalLayout)` **exactly
equals** the current four keys via `toEqual`. Adding a key to `journalLayout`
**will fail that test.** Choose ONE and do it cleanly:

- **Preferred:** add a *separate* exported object so `journalLayout` is
  untouched:
  ```ts
  /** Metrics for the floated journal sheet (issue 02 consumes these). */
  export const journalSheet = {
    cornerRadius: radius.lg, // 16 — rounded top of the sheet
    deskPaddingH: spacing(2), // 16 — desk visible left/right of the sheet
    deskPaddingTop: spacing(1.5), // 12 — desk visible above the sheet
  } as const;
  ```
- **Alternative:** extend `journalLayout` and update the `toEqual` list in the
  same PR. Only do this if you also re-justify why these belong on the same
  object.

Add a test asserting `journalSheet` values are positive numbers.

## Acceptance Criteria

- `colors.paper.desk` and `colors.paper.sheetEdge` exist and are valid 6-digit
  hex; `desk` is measurably darker (lower relative luminance) than
  `colors.paper.background`.
- `paperShadow.sheet` and `paperShadow.card` exist with both the iOS/web shadow
  props and an Android `elevation`.
- New sheet metrics are exported (preferably as `journalSheet`) **without**
  breaking the existing `journalLayout` exact-keys test.
- `editorialTokens.test.ts` is extended to cover the new keys and still asserts
  `ink`/`inkSoft` clear AA on `colors.paper.background`.
- `cd frontend && npm test && npm run lint && npx tsc --noEmit` all pass.

## Files to Modify

| File | Action |
|------|--------|
| `frontend/src/design/tokens.ts` | Modify — add `paper.desk`, `paper.sheetEdge`, `paperShadow`, sheet metrics |
| `frontend/src/design/__tests__/editorialTokens.test.ts` | Modify — assert new keys; keep AA + luminance checks |
</content>
