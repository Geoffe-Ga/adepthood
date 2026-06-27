# journal-resonance-13: Wire the resonance request flow

**Labels:** `frontend`, `enhancement`
**Epic:** [Journal Resonance](journal-resonance-epic.md)
**Depends on:** [journal-resonance-10](journal-resonance-10-api-client.md), [journal-resonance-11](journal-resonance-11-writing-surface.md), [journal-resonance-12](journal-resonance-12-get-resonance-button.md)
**Estimated LoC:** ~225

## Role

You are a React Native engineer connecting the Get-Resonance button to the
backend and managing the marginalia lifecycle on the entry screen.

## Goal

Add a `useResonance` hook that, on demand, ensures the draft is saved, calls
`resonance.generate`, stores the returned notes, and exposes loading/error
state and the current marginalia list (loaded via `resonance.list` on entry
open). Render the button through it. Notes are not yet drawn in the margin
(issue 14) — this issue owns state + the request, plus a minimal count indicator.

## Context

- API methods from issue 10 (`resonance.generate/list`).
- Button + idle from issue 12; screen from issue 11.
- Wallet semantics mirror the old chat: a `402` means out of messages/offerings.

## Tasks

1. **`frontend/src/features/Journal/useResonance.ts`**:
   - State: `marginalia: Marginalia[]`, `loading`, `error`, `remaining`.
   - On mount (entry has an id): `resonance.list(entryId)` → populate.
   - `requestResonance()`:
     - Ensure the entry is persisted (flush autosave / create if needed) so it
       has an id and the latest body.
     - Call `resonance.generate(entryId)`; merge returned notes into state;
       update remaining balances.
     - Map errors via `errorMessages` (e.g. `402` → a gentle "BotMason is resting"
       message); never crash the page.
2. **Wire into `JournalEntryScreen`** — compute `visible` from issue 12's
   `shouldShowResonance({ isIdle, hasContent, isLoading })`; pass `loading` and
   `onPress={requestResonance}`. Show a quiet indicator of how many notes exist
   (e.g. "3 notes in the margin") until issue 14 renders them.
3. **Resilience** — disable the button while a request is in flight; a second tap
   does not double-charge; an errored request can be retried.
4. **Tests** — `frontend/src/features/Journal/__tests__/useResonance.test.tsx`
   (mock API):
   - `requestResonance` saves then calls `generate`, and stores returned notes.
   - Existing notes load on mount via `list`.
   - `402` sets a friendly error and leaves the page usable.
   - In-flight guard prevents concurrent generates.

## Acceptance Criteria

- [ ] Tapping the button generates resonance for the saved entry and stores the
      notes; balances update.
- [ ] Notes for an existing entry load on open.
- [ ] Errors (esp. `402`) are handled gently; no double-charge on rapid taps.
- [ ] `npm run lint`, `npx tsc --noEmit`, `npm test` green.

## Files to Create / Modify

| File | Action |
|------|--------|
| `frontend/src/features/Journal/useResonance.ts` | **Create** |
| `frontend/src/features/Journal/JournalEntryScreen.tsx` | Modify (wire hook + button) |
| `frontend/src/features/Journal/__tests__/useResonance.test.tsx` | **Create** |

## Constraints

- Always resonate against the *saved* latest body (flush before request).
- One request in flight at a time; idempotent against rapid taps.
- No rendering of margin notes yet — just state + count (issue 14 draws them).
