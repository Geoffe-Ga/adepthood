# Epic: Give the Journal a floating-page depth & editorial polish

**Labels:** `epic`, `frontend`, `ux`, `design`
**Scope:** Frontend only (journal-resonance surface + shared design tokens)
**Estimated total LoC:** ~800

## Role

You are a senior React Native / front-end engineer with a strong visual
design sense, working inside Adepthood's existing **editorial / "paper"**
design language (`colors.paper.*`, `editorialType`, `journalLayout` in
`frontend/src/design/tokens.ts`). You make surfaces beautiful **through the
token system** — never with one-off magic numbers — and you treat
accessibility (WCAG 2.1 AA contrast, 44dp touch targets, reduced-motion)
as a non-negotiable part of "beautiful," not an afterthought.

## Goal

Make the journal **feel like writing on a real sheet of paper that floats a
little above a desk** — with margins, a soft warm shadow, and gentle motion —
instead of the current flat surface where the writing area and its background
are the same colour. After this epic ships, the journal writing page, the
marginalia, and the shelf all read as one cohesive, tactile, *floated*
editorial space, with **zero regressions** to existing behaviour, testIDs, or
contrast guarantees.

### What "flat" means today (the problem)

`JournalEntryScreen` paints its `SafeAreaView` and its page content with the
**same** colour — `colors.paper.background` (`#faf6ef`):

- `frontend/src/features/Journal/JournalEntry.styles.ts:28-31` — `safeArea`
  background is `colors.paper.background`.
- `frontend/src/features/Journal/JournalEntry.styles.ts:32-41` — the `page`
  sits directly on that same ground with only horizontal padding; there is no
  elevated surface, no shadow, no visible page edge, and no margin rule.

Because foreground and background are identical, the eye has nothing to
separate "the page" from "everything else." The shelf
(`JournalShelf.styles.ts`) has the same problem: entries are hairline-
separated rows on a single flat ground, and `MarginNote` cards are flat
fills with a coloured left bar. Nothing is *lifted*.

## Context

The journal already has a deliberate, well-tokenised editorial palette and
type scale — the raw materials for depth are mostly present:

- **Palette** — `colors.paper` (`tokens.ts:121-128`): `background` `#faf6ef`,
  `backgroundAlt` `#f3ecdf`, `ink` `#2b2620`, `inkSoft` `#5a5046`, `hairline`
  `#e3dccd`, `anchorHighlight`. Contrast of `ink`/`inkSoft` on the ground is
  AAA and is **asserted by tests** (see below) — do not break it.
- **Shadows** — `shadows` (`tokens.ts:274-303`) exist but are neutral-black
  and tuned for the grey app chrome, not the warm paper surface.
- **Layout metrics** — `journalLayout` (`tokens.ts:406-411`):
  `marginColumnWidth` 220, `pageHorizontalPadding` 24, `pageMaxWidth` 680,
  `marginNoteGap` 16.
- **Type** — `editorialType` (`tokens.ts:430-444`): a platform serif stack
  with display/title/body/note/caption/marginNote scales.

**Surfaces in scope:**

| File | Role |
|------|------|
| `frontend/src/design/tokens.ts` | Source of truth for every colour/shadow/metric |
| `frontend/src/features/Journal/JournalEntry.styles.ts` | Writing-page styles |
| `frontend/src/features/Journal/JournalEntryScreen.tsx` | Writing-page structure (`JournalPage`) |
| `frontend/src/features/Journal/MarginNote.tsx` | One margin note card |
| `frontend/src/features/Journal/JournalShelf.styles.ts` | Shelf list styles |
| `frontend/src/features/Journal/JournalShelfScreen.tsx` | Shelf structure |

**Hard contracts the epic must preserve (verified by existing tests):**

1. `JournalEntryScreen.test.tsx:151-155` flattens the `journal-page` style and
   asserts `paddingBottom === RESONANCE_BUTTON_CLEARANCE`. The `journal-page`
   testID and that exact `paddingBottom` value must remain on the page node.
2. `JournalEntryScreen.test.tsx:144-149` asserts the `journal-margin-column`
   testID exists and the `renderMargin` slot is invoked.
3. Read-mode testIDs `journal-body-read`, `highlight-<id>`, `margin-note-<id>`,
   and edit/finish testIDs must keep working.
4. `editorialTokens.test.ts:60-72` asserts `Object.keys(journalLayout)`
   **exactly equals** `['marginColumnWidth','pageHorizontalPadding',
   'pageMaxWidth','marginNoteGap']` via `toEqual`. **Adding a key to
   `journalLayout` will fail this test** — either extend the test in the same
   PR or put new metrics in a separate exported object (issue 01 decides this).
5. `editorialTokens.test.ts:27-45` asserts `colors.paper` *contains* its keys
   (`arrayContaining`) and that `ink`/`inkSoft` clear AA on the ground — adding
   `colors.paper` keys is safe; lowering contrast is not.

## Output Format

Six independently-shippable sub-issues. **Issue 01 (tokens) is the critical
path** — every other issue imports the elevation tokens it adds. After 01
lands, 02–05 can proceed in parallel; 06 (motion) lands last because it
animates the surfaces 02/04/05 build.

```
                 ┌── 02 floating-writing-sheet ──┐
                 │                                │
01 elevation ────┼── 03 ruled-margins-texture ───┼── 06 motion-&-micro-interactions
   tokens        │      (also depends on 02)      │
                 ├── 04 lift-marginalia-notes ────┤
                 │                                │
                 └── 05 floating-shelf-cards ─────┘
```

## Sub-issues

| # | Title | Scope | Est. LoC |
|---|-------|-------|----------|
| 01 | [Add editorial elevation tokens (desk + paper shadow)](journal-depth-01-elevation-tokens.md) | Frontend | ~120 |
| 02 | [Float the writing surface as a paper sheet](journal-depth-02-floating-writing-sheet.md) | Frontend | ~160 |
| 03 | [Add a ruled margin & page edge to the sheet](journal-depth-03-ruled-margins-and-texture.md) | Frontend | ~120 |
| 04 | [Lift the marginalia notes off the page](journal-depth-04-lift-marginalia-notes.md) | Frontend | ~110 |
| 05 | [Float the shelf entries as paper cards](journal-depth-05-floating-shelf-cards.md) | Frontend | ~170 |
| 06 | [Add depth-reinforcing motion (reduced-motion safe)](journal-depth-06-motion-and-micro-interactions.md) | Frontend | ~140 |

## Acceptance Criteria (epic-level)

- [ ] The journal writing page reads as a **lighter sheet floating on a deeper
      "desk" ground**, with a soft warm shadow and visible margins.
- [ ] The shelf and the marginalia share the same floated, layered language —
      the whole journal feature feels cohesive and tactile.
- [ ] Motion reinforces depth subtly and is fully disabled under
      "Reduce Motion."
- [ ] **No regressions:** every existing Journal test passes unchanged
      (testIDs, `RESONANCE_BUTTON_CLEARANCE`, read/edit/finish flows).
- [ ] **No contrast regressions:** all text keeps WCAG 2.1 AA (>= 4.5:1) on
      whatever ground it sits on; the token contrast tests stay green.
- [ ] All new styling flows from `tokens.ts` — no magic numbers in components
      or style files (CLAUDE.md guardrail).
- [ ] `cd frontend && npm test && npm run lint && npx tsc --noEmit` green; the
      backend is untouched. `pre-commit run --all-files` green on each PR.

## Constraints

- **Tokens only.** Every colour, radius, shadow, and spacing value comes from
  `tokens.ts`. No inline hex, no bare pixel constants in components.
- **Editorial palette only** for these surfaces — extend `colors.paper`, do
  not reach for the grey app-chrome palette (`colors.background.*`).
- **Preserve every testID and the `RESONANCE_BUTTON_CLEARANCE` contract.**
  Add depth by *wrapping* the existing `journal-page` node, not by moving the
  clearance padding off it.
- **Accessibility is part of the deliverable:** AA contrast, 44dp touch
  targets (`touchTarget.minimum`), and `prefers-reduced-motion` honoured.
- **React Native shadow portability:** specify both the iOS/web shadow props
  (`shadowColor/Offset/Opacity/Radius`) *and* Android `elevation`; assert via
  `StyleSheet.flatten` in tests rather than snapshotting.
- **TDD:** write/extend the failing test first, then implement. Keep coverage
  at or above the repo thresholds (90% line / 80% branch).
- One logical change per PR; conventional commit messages
  (`feat(frontend): …`, `style(frontend): …`, `test(frontend): …`).

## References

- `frontend/src/design/tokens.ts:121-128` — `colors.paper` palette
- `frontend/src/design/tokens.ts:274-303` — `shadows` (neutral; for contrast)
- `frontend/src/design/tokens.ts:406-411` — `journalLayout` metrics
- `frontend/src/design/tokens.ts:430-444` — `editorialType` scale
- `frontend/src/design/__tests__/editorialTokens.test.ts` — token contracts
- `frontend/src/features/Journal/JournalEntry.styles.ts` — writing-page styles
- `frontend/src/features/Journal/JournalEntryScreen.tsx:574-624` — `JournalPage`
- `frontend/src/features/Journal/__tests__/JournalEntryScreen.test.tsx:144-155` — layout contracts
- `frontend/src/features/Journal/MarginNote.tsx` — note card
- `frontend/src/features/Journal/JournalShelf.styles.ts` — shelf styles
</content>
</invoke>
