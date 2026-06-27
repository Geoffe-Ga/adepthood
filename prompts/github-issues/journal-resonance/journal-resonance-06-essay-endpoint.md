# journal-resonance-06: Essay expansion endpoint (lazy, cached)

**Labels:** `backend`, `enhancement`
**Epic:** [Journal Resonance](journal-resonance-epic.md)
**Depends on:** [journal-resonance-04](journal-resonance-04-resonance-service.md)
**Estimated LoC:** ~175

## Role

You are a backend engineer adding the on-demand "open this note into a full
essay" endpoint that backs the hovering essay modal.

## Goal

Add `POST /journal/marginalia/{marginalia_id}/essay` that lazily generates a
longer essay expanding a single margin note, caches it on the row, and returns
it. Idempotent: if the essay already exists, return it without re-generating or
re-charging.

## Context

- `Marginalia` has `essay: str | None` and `essay_generated_at` (issue 01).
- The LLM provider seam is the same one issue 04 uses.
- The note already carries its `kind`, `note`, and `anchor_text`; the parent
  entry's body provides context.

## Tasks

1. **Service fn** in `backend/src/domain/resonance.py`:
   `async generate_essay(*, llm, body, anchor_text, kind, note) -> str` — prompt
   the model to write a warm, letter-like essay (a few short paragraphs)
   expanding the note, grounded in the anchored passage and the entry. Sanitize
   output. Cap length to fit the `essay` column (10_000).
2. **Endpoint** — `POST /journal/marginalia/{id}/essay`:
   - Load the caller's marginalia (join through entry ownership) or `404`.
   - If `essay` is already set → return it as-is (no LLM, no charge).
   - Else generate, set `essay` + `essay_generated_at`, commit, return.
   - **Economy:** by default essay generation is *free* (the resonance pass was
     already charged). Leave a single clearly-marked seam where issue 20 can
     attach a charge. Document this default in the docstring.
3. **Response** — return the full `MarginaliaResponse` (now with `essay`
   populated) for the frontend to drop straight into the modal.
4. **Tests** — `backend/tests/test_essay_endpoint.py` (fake LLM):
   - First call generates + caches; `essay_generated_at` set.
   - Second call returns the cached essay; LLM **not** called again.
   - Another user's marginalia → `404`.
   - Generated essay is sanitized and within the length cap.

## Acceptance Criteria

- [ ] `POST .../essay` generates once, caches, and is idempotent thereafter.
- [ ] Ownership enforced via the parent entry; `user_id` not leaked.
- [ ] A documented seam exists for issue 20 to attach pricing.
- [ ] `./scripts/backend/check-all.sh` green.

## Files to Create / Modify

| File | Action |
|------|--------|
| `backend/src/domain/resonance.py` | Modify (add `generate_essay`) |
| `backend/src/routers/journal.py` | Modify (or `routers/resonance.py`) |
| `backend/tests/test_essay_endpoint.py` | **Create** |

## Constraints

- Idempotent by construction — never regenerate a cached essay.
- Reuse the existing LLM provider seam; no second integration.
- Keep the pricing default (free) isolated behind one obvious hook.
