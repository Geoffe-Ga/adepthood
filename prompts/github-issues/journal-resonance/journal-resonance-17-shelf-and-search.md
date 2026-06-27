# journal-resonance-17: Journal shelf + search restyle

**Labels:** `frontend`, `enhancement`
**Epic:** [Journal Resonance](journal-resonance-epic.md)
**Depends on:** [journal-resonance-09](journal-resonance-09-editorial-tokens.md), [journal-resonance-10](journal-resonance-10-api-client.md)
**Estimated LoC:** ~275

## Role

You are a React Native engineer building the entry point to the journal: a
**shelf** of pages you can browse, open, and search — replacing the chat list as
the journal's landing surface.

## Goal

Build `JournalShelfScreen`: a list of the user's entries as dated "pages"
(title + a body excerpt + date), with a "New entry" action and full-text search
restyled to the editorial aesthetic. Tapping a page opens `JournalEntryScreen`
with its `entryId`. Search reuses the existing `journal.list({ search })` path.

## Context

- `journal.list({ search, limit, offset })` exists with pagination
  (`total`, `has_more`). Search is length-bound server-side (3–64 chars).
- The current `SearchBar`/`TagFilter` and inverted message list are being
  replaced; tags are gone (categorization now lives in marginalia).
- Tokens from issue 09; the entry screen route from issue 11.

## Tasks

1. **`JournalShelfScreen.tsx`**:
   - A vertical list of entries (newest first) rendered as page cards: serif
     `title` (or "Untitled" + date), a 1–2 line body excerpt, the date, and a
     subtle marker if the page has marginalia (optional, from a count if
     available; otherwise omit).
   - "New entry" affordance → navigate to `JournalEntryScreen` with no id.
   - Pagination: load-more on scroll via `offset`/`has_more`.
   - Empty state styled editorially ("Your journal is empty — begin a page").
2. **Search** — a restyled search field that calls `journal.list({ search })`
   (debounced, honoring the 3-char minimum) and shows results as pages; a clear
   control returns to the full shelf. No tag filter.
3. **Make the shelf the journal tab landing** — point the Journal tab at the shelf;
   the entry screen is pushed on top. Keep deep-link entry (open a specific
   `entryId`) working.
4. **Tests** — `__tests__/JournalShelfScreen.test.tsx` (mock API):
   - Renders entries as page cards (title/excerpt/date), newest first.
   - "New entry" navigates to a blank entry screen.
   - Typing a query (≥3 chars) calls `list` with `search` and renders results.
   - Tapping a page navigates with the correct `entryId`.
   - Empty state shows when there are no entries.

## Acceptance Criteria

- [ ] The Journal opens to a shelf of pages (no chat list, no tag chips).
- [ ] Pages show title/excerpt/date and open the entry screen by id.
- [ ] Editorial search works against the existing `list` endpoint with the
      length guard respected.
- [ ] `npm run lint`, `npx tsc --noEmit`, `npm test` green.

## Files to Create / Modify

| File | Action |
|------|--------|
| `frontend/src/features/Journal/JournalShelfScreen.tsx` | **Create** |
| `frontend/src/features/Journal/JournalSearch.tsx` | **Create** (or fold into the shelf) |
| `frontend/src/navigation/*` | Modify (tab → shelf; push entry) |
| `frontend/src/features/Journal/__tests__/JournalShelfScreen.test.tsx` | **Create** |

## Constraints

- No tags/`TagFilter` — categorization is the AI's marginalia now.
- Reuse the existing `journal.list` search; keep the 3–64 char guard.
- Tokens only; respect `touchTarget.minimum`.
