# journal-resonance-14: Margin notes + inline anchor highlighting

**Labels:** `frontend`, `enhancement`
**Epic:** [Journal Resonance](journal-resonance-epic.md)
**Depends on:** [journal-resonance-11](journal-resonance-11-writing-surface.md), [journal-resonance-13](journal-resonance-13-wire-resonance.md)
**Estimated LoC:** ~275

## Role

You are a React Native engineer rendering the AI's marginalia the way notes
appear in the margin of a book — pinned beside the passage they refer to, with
the passage softly highlighted inline.

## Goal

Render each `Marginalia` as a `MarginNote` in the reserved margin column, aligned
near its anchored span, and highlight that span inline within the body. Tapping a
note (or its highlight) signals intent to open the essay (issue 15 supplies the
modal; this issue exposes an `onOpen(marginalia)` callback). Notes are labeled by
kind (theme/connection/symbol) using the kind accents from issue 09.

## Context

- Notes carry `anchor_start/anchor_end/anchor_text`, `kind`, `note`, `status`.
- The body is a long string; you need to render it with highlighted sub-ranges.
  In read mode the body can be a composed `<Text>` with nested highlighted
  `<Text>` children for each anchor range (sort + merge ranges; skip overlaps).
- The screen (issue 11) exposes a `renderMargin` slot and the body text.

## Tasks

1. **`MarginNote.tsx`** (presentational): a small serif card — kind label/pin in
   the kind accent color, the `note` text, a subtle "open" affordance. `stale`
   notes render dimmed (full styling of staleness is issue 16; expose the prop).
   Props: `{ note: Marginalia; onOpen: (n) => void }`.
2. **Inline highlight renderer** — a helper that, given `body` and the active
   marginalia, produces a highlighted `<Text>` tree: each anchor range wrapped in
   a highlight style (kind-tinted), tappable to `onOpen`. Pure, testable function
   `buildHighlightSegments(body, notes) → Segment[]`.
3. **Margin layout** — map notes into the `renderMargin` slot, attempting vertical
   alignment with their anchor (best-effort: order by `anchor_start`, stack with
   `marginNoteGap`; exact line-y alignment can be approximate). On narrow phones,
   collapse the margin to an inline affordance under the relevant paragraph or a
   bottom sheet list — pick the responsive approach already used elsewhere and
   keep it simple.
4. **Wire** into `JournalEntryScreen` via the slot + a read/preview rendering of
   the body with highlights. Editing vs. reading mode interplay is fine to keep
   minimal here; the deliberate-edit gate is issue 16.
5. **Tests** — `__tests__/MarginNote.test.tsx` and `buildHighlightSegments.test.ts`:
   - Segment builder splits the body at anchor boundaries; non-overlapping ranges
     each get a highlight; overlaps resolved deterministically.
   - `MarginNote` shows the kind label and fires `onOpen` on press.
   - Stale note renders the dimmed variant.

## Acceptance Criteria

- [ ] Marginalia render in the margin labeled by kind, with the anchored span
      highlighted inline.
- [ ] Tapping a note or its highlight invokes `onOpen(note)`.
- [ ] The segment builder is a pure, tested function handling overlaps/edges.
- [ ] `npm run lint`, `npx tsc --noEmit`, `npm test` green.

## Files to Create / Modify

| File | Action |
|------|--------|
| `frontend/src/features/Journal/MarginNote.tsx` | **Create** |
| `frontend/src/features/Journal/highlightSegments.ts` | **Create** |
| `frontend/src/features/Journal/JournalEntryScreen.tsx` | Modify (render margin + highlights) |
| `frontend/src/features/Journal/__tests__/MarginNote.test.tsx` | **Create** |
| `frontend/src/features/Journal/__tests__/highlightSegments.test.ts` | **Create** |

## Constraints

- Highlight math is a pure function — keep offset logic out of the component.
- Kind accents come from `colors.marginalia` (issue 09); no inline color literals.
- Don't implement the essay modal here — only the `onOpen` callback.
