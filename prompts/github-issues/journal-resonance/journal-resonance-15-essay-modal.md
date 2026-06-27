# journal-resonance-15: Hovering resonance essay modal

**Labels:** `frontend`, `enhancement`
**Epic:** [Journal Resonance](journal-resonance-epic.md)
**Depends on:** [journal-resonance-10](journal-resonance-10-api-client.md), [journal-resonance-14](journal-resonance-14-margin-notes.md)
**Estimated LoC:** ~225

## Role

You are a React Native engineer building the essay reader that **hovers above
the page** when the user opens a margin note — a letter/essay, not a chat reply.

## Goal

Build `ResonanceEssayModal`: tapping a margin note opens a modal that floats over
the writing (the page stays visible, dimmed, beneath it), shows the anchored
passage as a header, lazily fetches the essay via `resonance.essay`, and renders
it in warm editorial type. Closing returns to the page; the page never scrolls
into a conversation.

## Context

- `resonance.essay(marginaliaId)` (issue 10) lazily generates/caches the essay
  and returns the updated `Marginalia`.
- Issue 14 exposes `onOpen(note)`; this issue provides the modal it opens.
- Tokens from issue 09 (paper, serif, shadow/overlay).

## Tasks

1. **`ResonanceEssayModal.tsx`**:
   - Props: `{ note: Marginalia | null; onClose: () => void;
     onEssayLoaded?: (n: Marginalia) => void }`. Visible when `note` is non-null.
   - Presentation: a card hovering over a dimmed page (`colors.mystical.overlay`),
     not full-screen; the page remains partly visible behind it to reinforce
     "above your work, not a separate chat". Rounded, soft shadow, serif body.
   - Header: the `kind` label + the anchored passage (`anchor_text`) styled as a
     pulled quote.
   - Body: if `note.essay` is already present, show it immediately; else show a
     gentle loading state and call `resonance.essay(note.id)`; on success render
     the essay and bubble the updated note up via `onEssayLoaded` (so the list
     caches it and a re-open is instant). On error, a friendly retry.
   - Dismiss: tap the scrim, a close control, and Android back.
2. **Wire** into `JournalEntryScreen`: hold `openNote` state, pass `onOpen` from
   issue 14 to set it, render the modal, and update the cached note on
   `onEssayLoaded`.
3. **Tests** — `__tests__/ResonanceEssayModal.test.tsx` (mock API):
   - Opening a note without a cached essay fetches once and renders it.
   - Opening a note that already has an essay does **not** call the API.
   - Anchored passage + kind appear in the header.
   - Scrim/close dismisses; error state offers retry.

## Acceptance Criteria

- [ ] Tapping a margin note opens a hovering modal over the dimmed page (not a
      chat thread), lazily loading the essay.
- [ ] Cached essays render without a second request.
- [ ] Dismiss works via scrim, close control, and back button.
- [ ] `npm run lint`, `npx tsc --noEmit`, `npm test` green.

## Files to Create / Modify

| File | Action |
|------|--------|
| `frontend/src/features/Journal/ResonanceEssayModal.tsx` | **Create** |
| `frontend/src/features/Journal/JournalEntryScreen.tsx` | Modify (open/close state) |
| `frontend/src/features/Journal/__tests__/ResonanceEssayModal.test.tsx` | **Create** |

## Constraints

- The page stays visible beneath the modal — reinforce "hovering above your work".
- Lazy + cached: never refetch an essay the note already carries.
- Editorial type and tokens only; respect `touchTarget.minimum` and a11y labels.
