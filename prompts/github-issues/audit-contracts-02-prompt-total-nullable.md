# audit-contracts-02: Make `PromptListResponse.total` nullable + guard consumers

**Labels:** `audit-contracts`, `frontend`, `bug`, `priority-high`
**Epic:** Data-Layer Contracts & Schema Drift
**Estimated LoC:** ~150  (hard cap 700)

## Problem

`frontend/src/api/index.ts:1505-1509` types `PromptListResponse.total` as a
non-nullable `number`, but the backend declares it as `int | None`
(`backend/src/schemas/prompt.py:56`, with the docstring at line 53: "`total`
is `None` when not requested"). When the history endpoint omits the count,
`total` arrives as `null`; any consumer doing arithmetic on it
(`total - offset`, `total / limit`, a "showing N of `total`" label) produces
`NaN` or a wrong count, and the compile-time type lies about it. **Current
state:** frontend non-nullable type contradicts a nullable wire field — §5.4
class: schema drift (contracts).

## Scope

Covers: making `PromptListResponse.total` nullable on the frontend interface,
adding a matching Zod schema for `prompts.history` (the endpoint that returns
this shape — see also issue 03), and guarding every consumer that reads
`total`.

Does NOT cover: changing the backend to always populate `total`, or the
`journal.list` validation gap (issue 03 owns the journal half).

## Tasks

1. **Make the field nullable** — in `frontend/src/api/index.ts:1505-1509`,
   change `total: number` to `total: number | null` on `PromptListResponse`.
2. **Add a `promptListResponseSchema`** — in `frontend/src/api/schemas.ts`,
   define `promptDetailSchema` and `promptListResponseSchema` with
   `total: z.number().int().nullable()` and wire it into `prompts.history`
   (`index.ts:1522-1531`) via the `schema:` option (coordinate with issue 03,
   which adds the same kind of schema for `journal.list`).
3. **Guard consumers** — grep for `.total` reads of a `PromptListResponse`
   (history pagination UI / "showing N" labels) and guard with
   `total ?? items.length` or an explicit `null` branch so no `NaN` reaches the
   UI. TDD: a test that a `null` total renders/falls back correctly.

## Acceptance Criteria

- [ ] `PromptListResponse.total` is typed `number | null`; `tsc --noEmit`
      passes and every consumer compiles against the nullable type.
- [ ] A `prompts.history` response with `total: null` validates through
      `promptListResponseSchema` without error, proven by a `schemas.test.ts`
      case.
- [ ] No consumer produces `NaN` from a `null` total — proven by a test
      asserting the fallback path.
- [ ] No existing tests break; coverage ≥ 90%.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/api/index.ts` | Modify — `total: number \| null`, wire schema into `prompts.history` |
| `frontend/src/api/schemas.ts` | Modify — add `promptDetailSchema` + `promptListResponseSchema` |
| `frontend/src/api/__tests__/schemas.test.ts` | Modify — null-total validation case |
| Prompt-history consumer(s) | Modify — guard `total` reads |
</content>
