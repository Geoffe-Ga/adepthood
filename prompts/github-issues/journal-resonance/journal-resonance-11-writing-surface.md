# journal-resonance-11: Long-form writing surface (`JournalEntryScreen`)

**Labels:** `frontend`, `enhancement`
**Epic:** [Journal Resonance](journal-resonance-epic.md)
**Depends on:** [journal-resonance-09](journal-resonance-09-editorial-tokens.md), [journal-resonance-10](journal-resonance-10-api-client.md)
**Estimated LoC:** ~300

## Role

You are a React Native engineer building the page the user writes in — the
centerpiece of the redesign. This issue ships the writing surface only; margin
notes (14), the Get-Resonance button (12), and the essay modal (15) layer on top.

## Goal

Build `JournalEntryScreen`: a warm, editorial long-form page with an optional
title and a large multiline body, autosaving as a draft. No chat bubbles, no
send button. It loads an existing entry by id or starts a new draft, and renders
a reserved right-hand **margin column** (empty for now) that later issues fill
with notes.

## Context

- Tokens from issue 09 (`typography.serif`, `colors.paper`, `journalLayout`).
- API from issue 10 (`journal.create`, `journal.get`, `journal.update`).
- The current `JournalScreen.tsx` is the chat orchestrator being replaced; you may
  read it for context but do not depend on its hooks.

## Tasks

1. **`frontend/src/features/Journal/JournalEntryScreen.tsx`**:
   - Layout: paper background, generous horizontal padding, a serif title input
     (placeholder "Untitled") and a flexible serif body `TextInput` (multiline,
     grows with content), with a **reserved margin column** of
     `journalLayout.marginColumnWidth` on the right (or below on narrow phones —
     responsive). Accept a `renderMargin?: ReactNode` slot so issue 14 can inject
     notes without changing this component's internals.
   - Load: if a route param `entryId` is present, fetch via `journal.get`;
     otherwise start a blank draft.
   - **Autosave**: debounce body/title changes (~1.5s idle) and persist via
     `journal.create` (first save) then `journal.update`. Track
     `status: 'draft' | 'finished'` and a `lastSavedAt`.
   - Expose, via context or props, the current body text + an `isTyping`/idle
     signal that issue 12's button consumes (don't build the button here).
   - Empty/loading/error states styled to the editorial aesthetic.
2. **Styles** — a new `JournalEntry.styles.ts` (do not overload the old
   `Journal.styles.ts`); consume tokens, no magic numbers.
3. **Navigation** — register the screen so it can be opened with/without an
   `entryId`. (Wiring the tab to default here vs. the shelf is issue 17; just make
   the screen routable.)
4. **Tests** — `frontend/src/features/Journal/__tests__/JournalEntryScreen.test.tsx`:
   - Renders title + body inputs (no chat input, no message bubbles).
   - Typing in the body triggers a debounced save (fake timers → `update`/`create`
     called once after idle).
   - Loads an existing entry's title/body by id.
   - Renders the `renderMargin` slot content when provided.

## Acceptance Criteria

- [ ] A long-form editable page (title + body) renders with editorial styling and
      a reserved margin column; no chat UI present.
- [ ] Autosave persists drafts on idle without a manual send action.
- [ ] Existing entries load by id; new entries start blank.
- [ ] `npm run lint`, `npx tsc --noEmit`, `npm test` green.

## Files to Create / Modify

| File | Action |
|------|--------|
| `frontend/src/features/Journal/JournalEntryScreen.tsx` | **Create** |
| `frontend/src/features/Journal/JournalEntry.styles.ts` | **Create** |
| `frontend/src/navigation/*` | Modify (register route) |
| `frontend/src/features/Journal/__tests__/JournalEntryScreen.test.tsx` | **Create** |

## Constraints

- No chat constructs anywhere (no bubbles, no inverted list, no send button).
- Keep the margin column a pluggable slot — issue 14 must not need to rewrite this
  component.
- All spacing/typography/color from tokens; respect `touchTarget.minimum`.
