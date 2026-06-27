# journal-resonance-10: API client — entry edit, resonance, marginalia, essay

**Labels:** `frontend`, `enhancement`
**Epic:** [Journal Resonance](journal-resonance-epic.md)
**Depends on:** [journal-resonance-05](journal-resonance-05-resonance-endpoints.md), [journal-resonance-06](journal-resonance-06-essay-endpoint.md)
**Estimated LoC:** ~200

## Role

You are a React Native engineer extending the typed API client to cover the new
journal-resonance endpoints.

## Goal

Add TypeScript types and client methods for: editing an entry (`PATCH`), running
a resonance pass, listing marginalia, and expanding a note into an essay. Match
the backend shapes from the epic contract exactly.

## Context

- `frontend/src/api/index.ts` holds the `journal`, `botmason`, and `prompts`
  clients with `ApiError` handling and token-passing conventions.
- The backend shapes are fixed in the epic contract (Marginalia response,
  `ResonanceResponse`, etc.).

## Tasks

1. **Types**:
   - `type MarginaliaKind = 'theme' | 'connection' | 'symbol'`
   - `type MarginaliaStatus = 'active' | 'stale'`
   - `type EntryStatus = 'draft' | 'finished'`
   - `interface Marginalia` (exact epic response shape, `essay: string | null`).
   - `interface ResonanceResponse { marginalia: Marginalia[];
     remaining_messages: number; remaining_balance: number;
     monthly_reset_date: string }`.
   - Extend `JournalMessage` with `title: string | null`, `status: EntryStatus`,
     `updated_at: string`.
   - `interface JournalEntryUpdate { message?: string; title?: string | null;
     status?: EntryStatus }`.
2. **Methods**:
   - `journal.update(entryId, patch: JournalEntryUpdate, token?)` → `PATCH /journal/{id}`.
   - `resonance.generate(entryId, token?)` → `POST /journal/{id}/resonance`
     returning `ResonanceResponse`.
   - `resonance.list(entryId, token?)` → `GET /journal/{id}/marginalia`
     returning `{ items: Marginalia[] }`.
   - `resonance.essay(marginaliaId, token?)` → `POST /journal/marginalia/{id}/essay`
     returning `Marginalia` (with `essay` populated).
   - Reuse the existing fetch/error/retry helpers; map errors via the existing
     `errorMessages` module (add any new detail codes, e.g. for `402`).
3. **Tests** — `frontend/src/api/__tests__/resonance.test.ts` (mock fetch):
   - Each method hits the right URL/verb and parses the response.
   - `ApiError` surfaces status + detail for `402`/`404`.
   - `update` serializes only provided fields.

## Acceptance Criteria

- [ ] Typed methods for update / resonance / marginalia list / essay exist and are
      tested against mocked fetch.
- [ ] Types match the epic contract (kinds, status, nullable essay).
- [ ] `npm run lint`, `npx tsc --noEmit`, `npm test` green.

## Files to Create / Modify

| File | Action |
|------|--------|
| `frontend/src/api/index.ts` | Modify |
| `frontend/src/api/errorMessages.ts` | Possibly modify |
| `frontend/src/api/__tests__/resonance.test.ts` | **Create** |

## Constraints

- No `any`; strict types throughout.
- Reuse existing request/error/retry plumbing; don't fork the client.
- Client only — no UI in this issue.
