# journal-resonance-04: Resonance generation service (LLM → anchored margin notes)

**Labels:** `backend`, `enhancement`
**Epic:** [Journal Resonance](journal-resonance-epic.md)
**Depends on:** [journal-resonance-01](journal-resonance-01-marginalia-model.md)
**Estimated LoC:** ~275

## Role

You are a backend engineer writing the domain service that turns a journal
entry's body into a set of **anchored margin notes** using the LLM. This is pure
domain logic with the LLM injected — no FastAPI route, no DB writes.

## Goal

Implement `backend/src/domain/resonance.py` with a function that asks the LLM to
read an entry and return short notes (kind + a verbatim quote + the note text),
then resolves each quote to character offsets within the body. The endpoint
(issue 05) persists the result and charges the wallet.

## Context

- BotMason's existing LLM provider/call helpers live in
  `backend/src/routers/botmason.py` (provider abstraction, BYOK header, model
  selection). Reuse that provider seam — do **not** add a second integration.
- `MarginaliaKind` is `theme | connection | symbol` (issue 01).
- Notes anchor by **character offsets + verbatim snapshot**, per the epic
  contract. The LLM returns the *quote*; this service finds it in the body.

## Tasks

1. **Drafts** — define `MarginaliaDraft` (pydantic or dataclass):
   `{ kind: MarginaliaKind, quote: str, note: str }` and the resolved
   `MarginaliaAnchored`: `{ kind, anchor_start, anchor_end, anchor_text, note }`.
2. **Prompt** — a structured system/user prompt instructing the model to:
   - read the whole entry; surface up to `max_notes` (default 5) of the *most*
     resonant observations;
   - for each, pick a short verbatim `quote` copied **exactly** from the body
     (≤ 280 chars), classify it as theme/connection/symbol, and write a 1–2
     sentence `note` in a warm, literary, second-person voice (a reader writing
     in the margin — never instructions, never "as an AI").
   - return strict JSON (a list of `{kind, quote, note}`).
   - Optionally accept `prior_entries: list[str]` excerpts so `connection` notes
     can reference earlier writing.
3. **Parse + anchor** — `async generate_marginalia(body, *, llm, prior_entries=None,
   max_notes=5) -> list[MarginaliaAnchored]`:
   - Call the LLM, parse JSON defensively (tolerate fenced code blocks, extra
     prose) → list of drafts; drop malformed items.
   - For each draft, locate `quote` in `body` (first exact occurrence) →
     `anchor_start/anchor_end/anchor_text`. If the quote is not found verbatim,
     **drop** that note (don't guess offsets).
   - Validate `kind ∈ MarginaliaKind`; sanitize `note` via `sanitize_user_text`.
   - De-dupe overlapping anchors (keep the first); cap at `max_notes`.
4. **Tests** — `backend/tests/test_resonance_service.py` with a **fake LLM**:
   - Given a body and a stub returning two valid drafts whose quotes appear in
     the body → two anchored notes with correct offsets and `anchor_text`.
   - A draft whose quote is absent from the body is dropped.
   - Malformed JSON / unknown kind is dropped without raising.
   - Offsets satisfy `body[start:end] == anchor_text`.
   - `max_notes` is respected.

## Acceptance Criteria

- [ ] `generate_marginalia` returns anchored notes whose offsets exactly index
      the body, using the injected LLM (no network in tests).
- [ ] Absent-quote / malformed / unknown-kind drafts are dropped, never crash.
- [ ] Notes are sanitized and capped at `max_notes`.
- [ ] `./scripts/backend/check-all.sh` green.

## Files to Create / Modify

| File | Action |
|------|--------|
| `backend/src/domain/resonance.py` | **Create** |
| `backend/tests/test_resonance_service.py` | **Create** |
| `backend/src/routers/botmason.py` | Possibly modify (export the provider seam) |

## Constraints

- The LLM is an injected dependency; the service has zero FastAPI/DB imports.
- Offsets must come from locating the verbatim quote — never trust model-supplied
  indices.
- Keep the model's voice constraints in the prompt: marginalia are a reader's
  notes, not assistant chat. No "as an AI", no instructions to the user.
