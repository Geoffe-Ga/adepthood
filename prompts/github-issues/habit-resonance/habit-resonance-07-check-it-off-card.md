# habit-resonance-07: "Check it off?" margin card + OK / Not-now wiring

**Epic:** Check off habits & practices from the journal's resonance pass ·
**Depends on:** 06 (hook + client) · **Scope:** Frontend · **Est. LoC:** ~260

## Problem

This is the moment the user sees: pressing **Get Resonance** makes a small
comment pop up in the margin next to the sentence — *"You wrote about **Daily
run**. Check it off?"* — with a clear **OK** and a quiet **Not now**. Tapping
**OK** logs the completion and the card settles into *"✓ Checked off — 4-day
streak"*. It renders **as marginalia**, interleaved with the literary notes and
ordered by anchor position, but is visually an actionable card, not a note.

## Tasks

### 1. `CompletionSuggestionNote` — `frontend/src/features/Journal/CompletionSuggestionNote.tsx`

A presentational card (sibling to `MarginNote.tsx`, reusing its
`paperShadow.card`, `editorialType`, `colors.paper`, `touchTarget`, the
`usePressScale` motion + `useReducedMotion`):

- **Pending:** a kind pin/icon (a small check affordance, accent
  `colors.marginalia` or a dedicated token), the question
  *"You wrote about {label}. Check it off?"* (label from `note.label`), and a
  row with a primary **OK** (`Button`/`TouchableOpacity`, ≥44dp, accessibility
  label "Check off {label}") and a tertiary **Not now** ("Dismiss {label}
  suggestion"). `testID="suggestion-{id}"`, `testID="suggestion-accept-{id}"`,
  `testID="suggestion-dismiss-{id}"`.
- **Accepting:** disable both controls, show a subtle in-flight state (no
  spinner churn — a quiet "Checking…"), so a mashed tap can't double-fire (the
  hook also guards per id).
- **Accepted:** replace the prompt with *"✓ Checked off"* + a streak line when a
  `check_in` streak is available (e.g. "4-day streak"); the card reads as
  resolved (settled, not a button anymore). `testID="suggestion-accepted-{id}"`.
- **Dismissed:** the card removes itself from the margin (don't render
  `dismissed` rows) — keep the margin uncluttered.
- Reduced-motion-safe; **tokens only**, no magic numbers or inline hex; copy
  strings as named constants at the top of the file.

### 2. Interleave into the margin — `JournalEntryScreen.tsx` / `MarginNoteList`

- Build one ordered stream of margin items from **both** `marginalia` and
  pending/accepted `suggestions`, sorted by `anchor_start` (a tiny discriminated
  union: `{ kind: 'note' | 'suggestion', anchorStart, … }`), rendering
  `MarginNote` or `CompletionSuggestionNote` per item. Filter out `dismissed`
  suggestions.
- Pass `onAccept`/`onDismiss` from the controller (wired to the hook's
  `acceptSuggestion`/`dismissSuggestion`) down to the card. On accept, the hook
  updates the row to `accepted` (and the streak), so the card re-renders into
  its confirmed state with no extra plumbing.
- Keep all existing journal testIDs and the `RESONANCE_BUTTON_CLEARANCE`
  contract intact — add the stream, don't move the page node.

### 3. (Optional, same PR if cheap) accepted feedback

If a lightweight toast exists in the app, fire a "Checked off — N-day streak"
toast on accept; otherwise the in-card confirmed state is sufficient. Don't
build new toast infra here.

## Tasks — tests

- `CompletionSuggestionNote.test.tsx`: pending renders the question with the
  label and both controls (≥44dp, correct a11y labels/testIDs); pressing **OK**
  calls `onAccept(id)` once and disables the controls; the accepted variant shows
  "✓ Checked off" + streak; a `dismissed` note renders nothing; reduced-motion
  path renders without animation.
- `JournalEntryScreen.test.tsx` (extend): given marginalia + a pending
  suggestion at known anchors, the margin renders both interleaved in
  `anchor_start` order; pressing the suggestion's OK invokes the hook's accept;
  a dismissed suggestion is absent; existing layout/testID assertions
  (`journal-page`, `RESONANCE_BUTTON_CLEARANCE`, margin column) still pass.

## Acceptance criteria

- [ ] Pressing Get Resonance shows, in the margin, a *"You wrote about {habit}.
      Check it off?"* card pinned in anchor order beside the literary notes.
- [ ] **OK** logs the completion (via the hook) and the card settles to a
      confirmed "✓ Checked off" + streak state; **Not now** removes it.
- [ ] Double-tap safe (card disables + hook per-id guard); reduced-motion-safe;
      tokens only; all existing Journal tests pass unchanged.
- [ ] `cd frontend && npm test && npm run lint && npx tsc --noEmit` green.

## Files

| File | Action |
|------|--------|
| `frontend/src/features/Journal/CompletionSuggestionNote.tsx` | New — the actionable margin card |
| `frontend/src/features/Journal/JournalEntryScreen.tsx` | Modify — interleave suggestions into the margin stream + wire accept/dismiss |
| `frontend/src/features/Journal/__tests__/CompletionSuggestionNote.test.tsx` | New |
| `frontend/src/features/Journal/__tests__/JournalEntryScreen.test.tsx` | Modify |

## Constraints

- Reuse `MarginNote`'s card language (`paperShadow.card`, `editorialType`,
  `colors.paper`, `usePressScale`, `touchTarget.minimum`); the suggestion card
  is a *variant*, not a new visual system. No magic numbers / inline hex.
- Preserve every existing Journal testID and the `RESONANCE_BUTTON_CLEARANCE`
  contract. Accessibility (44dp targets, labels, reduced motion) is part of done.
