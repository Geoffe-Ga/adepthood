---
type: "query"
date: "2026-08-26T02:59:48+00:00"
question: "What depends on the journal read view's styles and the Get Resonance button, so a layout change knows every test it can break?"
contributor: "graphify"
outcome: "useful"
source_nodes: ["JournalEntry.styles.ts", "RESONANCE_BUTTON_CLEARANCE", "GetResonanceButton()", "shouldShowResonance()", "HighlightedBody()", "interactiveTextFloor.test.ts", "JournalEntryScreen.tsx"]
---

# Q: What depends on the journal read view's styles and the Get Resonance button, so a layout change knows every test it can break?

## Answer

Walking incoming edges to every node in `JournalEntry.styles.ts`, `GetResonanceButton.tsx`,
`MarginNote.tsx` and `HighlightedBody.tsx` returned two dependents that a grep confined to
`frontend/src/features/Journal/` would not have found, and both turned out to constrain the
change:

- `frontend/src/design/__tests__/interactiveTextFloor.test.ts` imports
  `JournalEntry.styles`. It walks every source file in the tree for `...editorialType.caption`
  and diffs the found set against a hardcoded, manually audited allowlist, so *any* new caption
  usage anywhere fails a design-system audit that lives nowhere near the journal feature.
- `RESONANCE_BUTTON_CLEARANCE` (`JournalEntry.styles.ts:L33`) is imported by
  `frontend/src/features/Journal/__tests__/JournalEntryScreen.test.tsx`, which asserts the page's
  `paddingBottom` equals it. Making that padding conditional therefore had to change a named
  existing assertion deliberately rather than silently.

`shouldShowResonance()` also showed an inbound `calls` edge from `deriveResonanceGate()` in
`JournalEntryScreen.tsx`, which is what flagged that the read view and the writing surface share
one visibility rule — the reason the read row needed its own steady gate instead of inheriting
idle detection.

Node source locations: `JournalEntry.styles.ts:L33` (RESONANCE_BUTTON_CLEARANCE),
`GetResonanceButton.tsx:L18` (shouldShowResonance), `GetResonanceButton.tsx:L50`
(GetResonanceButton), `HighlightedBody.tsx:L134` (HighlightedBody).

## Outcome

- Signal: useful

## Source Nodes

- JournalEntry.styles.ts
- RESONANCE_BUTTON_CLEARANCE
- GetResonanceButton()
- shouldShowResonance()
- HighlightedBody()
- interactiveTextFloor.test.ts
- JournalEntryScreen.tsx
