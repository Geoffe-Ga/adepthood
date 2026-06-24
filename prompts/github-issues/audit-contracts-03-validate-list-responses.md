# audit-contracts-03: Validate `journal.list` & `prompts.history` responses

**Labels:** `audit-contracts`, `frontend`, `bug`, `priority-high`
**Epic:** Data-Layer Contracts & Schema Drift
**Estimated LoC:** ~220  (hard cap 700)

## Problem

`journal.list` (`frontend/src/api/index.ts:1169-1180`) and `prompts.history`
(`frontend/src/api/index.ts:1522-1531`) call `request<T>()` with **no `schema`
option**. `parseResponse` (`index.ts:400-405`) only validates when a schema is
passed; without one it does `return data as T` — an unchecked cast. A
mis-shaped envelope (renamed key, a `null` where an object is expected, a
non-array `items`) therefore sails past the API edge and detonates as a deep
`TypeError` inside the Journal / Prompts screens, with no stack frame in the
API layer. **Current state:** two list endpoints have zero runtime validation —
§5.4 class: schema drift / unvalidated contracts (audit §7).

## Scope

Covers: adding real Zod response schemas for the journal list envelope
(`JournalListResponse`) and the prompt history envelope
(`PromptListResponse`), and wiring them into the two call sites.

Does NOT cover: the per-paginated-endpoint `loosePageSchema` work (issue 04) —
these two endpoints return their own bespoke `{ items, total, has_more }`
envelopes, not the generic `Page<T>`. The nullable `total` field on the prompt
envelope is owned by issue 02; this issue should depend on / coordinate with it
so the prompt schema is defined once.

## Tasks

1. **`journalMessageSchema` + `journalListResponseSchema`** — in
   `frontend/src/api/schemas.ts`, model `JournalMessage` (`index.ts:1130-1153`:
   `id`, `content`, `sender`, `tag`, `practice_session_id` / `user_practice_id`
   nullable, timestamps) and wrap it in
   `{ items: z.array(journalMessageSchema), total: z.number().int(), has_more: z.boolean() }`.
2. **Wire into `journal.list`** — pass
   `schema: journalListResponseSchema` to the `request()` call at
   `index.ts:1179`.
3. **`promptListResponseSchema`** — define (or reuse from issue 02) the prompt
   detail + list schemas with `total` nullable, and wire into `prompts.history`
   at `index.ts:1530`.
4. **TDD** — for each endpoint, a test that a well-formed envelope parses and a
   mis-shaped one (non-array `items`, missing `has_more`) throws
   `ApiValidationError` rather than escaping as a raw value.

## Acceptance Criteria

- [ ] `journal.list` and `prompts.history` both pass a Zod `schema` to
      `request()`; no `request<…ListResponse>()` call in `index.ts` is
      schema-less.
- [ ] A mis-shaped journal envelope (e.g. `items: null`) surfaces as
      `ApiValidationError` at the API edge, proven by a `schemas.test.ts` case.
- [ ] A well-formed envelope for each endpoint round-trips with all fields
      intact (including nullable `practice_session_id` / `total`).
- [ ] No existing tests break; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/api/schemas.ts` | Modify — add journal + prompt list schemas |
| `frontend/src/api/index.ts` | Modify — wire schemas into `journal.list` & `prompts.history` |
| `frontend/src/api/__tests__/schemas.test.ts` | Modify — valid + mis-shaped cases per endpoint |
</content>
