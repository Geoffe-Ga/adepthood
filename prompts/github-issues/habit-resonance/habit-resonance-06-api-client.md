# habit-resonance-06: API client + types + `useResonance` surfacing

**Epic:** Check off habits & practices from the journal's resonance pass ·
**Depends on:** 04 (endpoint contract), 05 (accept/dismiss) · **Scope:** Frontend ·
**Est. LoC:** ~220

## Problem

The frontend needs typed access to suggestions: a client for list/accept/
dismiss, the new types, the extended `ResonanceResponse`, and `useResonance`
surfacing suggestions the same way it surfaces marginalia (load on open, merge
from a generate pass, expose accept/dismiss with one-in-flight protection and
friendly error mapping). No UI yet — that's issue 07.

## Tasks

### 1. Types + client — `frontend/src/api/`

- Add to `schemas.ts` (mirror `Marginalia`): `CompletionTargetType =
  'habit' | 'practice'`; `SuggestionStatus = 'pending' | 'accepted' |
  'dismissed'`; `CompletionSuggestion` (the response fields from issue 04, no
  `user_id`); `CheckInResult` already exists; `AcceptSuggestionResult {
  suggestion: CompletionSuggestion; check_in: CheckInResult }`.
- Extend `ResonanceResponse` with `suggestions: CompletionSuggestion[]`.
- In `index.ts`, add a `completionSuggestions` client next to `resonance`:
  - `list(entryId, token?) => GET /journal/{id}/suggestions` → `{ items }`.
  - `accept(suggestionId, token?) => POST /journal/suggestions/{id}/accept` →
    `AcceptSuggestionResult`. Pass an **idempotency key** like the
    `goalCompletions.create` precedent (`accept-suggestion:${id}`) so a mashed
    OK can't double-fire.
  - `dismiss(suggestionId, token?) => POST /journal/suggestions/{id}/dismiss` →
    `CompletionSuggestion`.
  - Use the same trailing-slash / `request` / `byokHeaders` conventions as the
    `resonance` client. Export it from the default `api` aggregate.

### 2. Surface in `useResonance` — `frontend/src/features/Journal/useResonance.ts`

- Add `suggestions: CompletionSuggestion[]` to state; load via
  `completionSuggestions.list` in the on-open effect (sibling to
  `useInitialMarginalia`) and merge the `result.suggestions` from a generate
  pass (reuse a `mergeById` keyed by id; incoming wins; sort by `anchor_start`).
- Expose:
  - `acceptSuggestion(id): Promise<void>` — guards one-in-flight **per id**
    (a `Set<number>` of in-flight ids), calls the client, replaces the row with
    the returned `suggestion` (now `accepted`), and exposes the returned
    `check_in` to the caller (e.g. via a transient map `lastCheckInById` or by
    returning it). Errors mapped with `formatApiError`, surfaced without
    crashing; the row stays `pending` on failure so the user can retry.
  - `dismissSuggestion(id): Promise<void>` — optimistic flip to `dismissed`,
    reverts on error.
- Keep the existing marginalia behavior untouched (one resonance pass at a
  time, 402 handling, etc.).

## Tasks — tests

- `frontend/src/api/__tests__/completionSuggestions.test.ts`: list/accept/dismiss
  hit the canonical URLs/methods (a 307-on-wrong-slash guard like the existing
  `resonance.test.ts`); accept sends the idempotency header.
- `useResonance.test.tsx` (extend): suggestions load on open and merge from a
  generate pass; `acceptSuggestion` replaces the row with the accepted one and
  exposes `check_in`; a failed accept leaves the row `pending`; `dismissSuggestion`
  optimistically flips and reverts on error; the same id can't double-accept
  while in flight.

## Acceptance criteria

- [ ] `completionSuggestions.{list,accept,dismiss}` typed and canonical-URL
      tested; accept carries an idempotency key.
- [ ] `ResonanceResponse.suggestions` typed; `useResonance` loads, merges, and
      exposes `acceptSuggestion`/`dismissSuggestion` with per-id in-flight
      guarding and non-crashing error mapping.
- [ ] Existing marginalia/resonance behavior unchanged.
- [ ] `cd frontend && npm test && npm run lint && npx tsc --noEmit` green.

## Files

| File | Action |
|------|--------|
| `frontend/src/api/schemas.ts` | Modify — suggestion types, `ResonanceResponse.suggestions` |
| `frontend/src/api/index.ts` | Modify — `completionSuggestions` client + aggregate export |
| `frontend/src/features/Journal/useResonance.ts` | Modify — surface suggestions + accept/dismiss |
| `frontend/src/api/__tests__/completionSuggestions.test.ts` | New |
| `frontend/src/features/Journal/__tests__/useResonance.test.tsx` | Modify |

## Constraints

- Mirror the existing `resonance` client and `goalCompletions` idempotency-key
  conventions exactly; no new HTTP plumbing. No `any` — full types. The hook
  stays presentation-free (no JSX, no copy strings — those live in issue 07).
