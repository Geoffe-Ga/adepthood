# design-act2-05: Journal shelf as an editorial library

**Labels:** `frontend`, `ux`, `design`
**Epic:** [Candle & Ink, Act II](design-act2-epic.md)
**Depends on:** 01 (scaffold), 03 (empty state)
**Estimated LoC:** ~240

## Problem

The Journal **writing surface** is the app's design flagship (floating paper
sheet, marginalia, resonance — owned and polished by the journal-depth epic). The
**shelf** that fronts it is the weakest link and reads as a different product:

- The search bar reverts to generic grey chrome — `colors.background.*` +
  `colors.text.secondary`, an emoji 🔍 toggle (`SearchBar.tsx:142-201`) — instead
  of the warm editorial palette the cards already use.
- The list is a flat, undifferentiated `FlatList` of identical cards
  (`JournalShelfScreen.tsx:231-273`); no time grouping, no hierarchy, no sense of
  a *library* you are accumulating.
- The empty state is one bare line ("Your shelf is empty — start a page.",
  `:160-177`) with no warmth or invitation.
- The "New entry" button uses `colors.primary` dark brown, not the warm accent;
  navigation has no header voice consistent with the rest of the app.

## Scope

Re-imagine the shelf as a curated personal **library** in the warm language —
layout, IA, and discovery — without touching the Entry screen or the journal data
layer. Migrate search into the warm palette, group entries by time, lift cards on
the desk ground, and give an inviting empty state.

## Tasks

### 1. Header & search in the warm language

- Adopt `ScreenScaffold` + `ScreenHeader` (eyebrow "JOURNAL", serif display title
  "Your shelf", a one-line lead). Move "New entry" into the header `action` slot
  as an accent `Button`.
- Restyle `SearchBar.tsx` onto the warm palette: `surface.raised`/`surface.sunken`
  ground, `ink`/`accent` text + caret, a serif placeholder, and a soft warm
  collapse/expand. Add a "no results" line (`type().body`, `ink.soft`) and reuse
  the existing debounce/min-char logic unchanged.

### 2. Group the list into a library

- Section the entries by recency — **This week / This month / Earlier** (derive
  buckets from entry timestamps; keep the existing offset pagination). Render with
  a `SectionList` (or grouped FlatList) so the shelf reads as an accumulating
  archive, not a flat scroll.
- Lift each `PageCard` onto the `surface.desk` ground with `surfaceShadow.card`,
  matching the Entry sheet's floated metaphor; add a quiet reading-time / "saved
  ⋯ ago" caption (`type().caption`, `ink.muted`).
- Keep the weekly-prompt card but promote it to a distinct, more prominent slot
  directly under the header (its own band, not an in-list row).

### 3. Inviting empty state

- Replace the bare empty line with the shared `EmptyState` (issue 03): a quill/
  candle glyph, a serif invitation ("Begin your first reflection"), and a primary
  CTA into a blank entry.

## Tasks — tests

- `JournalShelfScreen.test.tsx`: header renders with the serif title + accent
  "New entry" action; entries render under time-group section headers; tapping a
  card still navigates with `entryId`; the weekly-prompt slot navigates with
  `weekNumber`/`promptQuestion`/`prefillTitle` (existing wiring preserved).
- `SearchBar.test.tsx`: warm tokens (no `colors.background.*`); debounce/min-char
  behaviour unchanged; "no results" copy shows on an empty result set.
- Empty-state path renders `EmptyState` with a working CTA.

## Acceptance Criteria

- The shelf reads as a warm, grouped library cohesive with the Entry surface;
  search is on the warm palette; the empty state invites a first entry.
- All journal navigation (open entry, new entry, weekly prompt) works unchanged;
  pagination + search behaviour preserved.
- No legacy `colors.background.*`/`colors.text.secondary` left on the shelf; no
  magic numbers. `cd frontend && npm test && npm run lint && npx tsc --noEmit`
  green.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/Journal/JournalShelfScreen.tsx` | Modify — scaffold, grouping, prompt slot |
| `frontend/src/features/Journal/JournalShelf.styles.ts` | Modify — warm desk/lift, drop grey |
| `frontend/src/features/Journal/SearchBar.tsx` | Modify — warm palette + no-results |
| `frontend/src/features/Journal/__tests__/*.test.tsx` | Modify |
