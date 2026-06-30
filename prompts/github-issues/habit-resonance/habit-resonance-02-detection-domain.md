# habit-resonance-02: Completion-detection domain service (LLM pass)

**Epic:** Check off habits & practices from the journal's resonance pass ·
**Depends on:** — (pure domain) · **Scope:** Backend · **Est. LoC:** ~220

## Problem

We need a pure, injected-LLM function that reads an entry and decides which of
the user's tracked habits/practices the writer actually *did* — returning
anchored, validated hits — with the same trust model as `domain/resonance.py`:
the model proposes a candidate **index** and a verbatim **quote**; the server
resolves the index against the supplied list and anchors the quote itself,
never trusting model-supplied ids or offsets. No FastAPI, no DB.

## Tasks — `backend/src/domain/detection.py`

Mirror the shape of `domain/resonance.py` (`Protocol` LLM seam, defensive JSON
parse, verbatim quote → span, overlap de-dupe, cap).

- Reuse `ResonanceLLM` from `domain.resonance` as the injected seam (or re-export
  a `DetectionLLM` alias) — one `complete(prompt) -> str` method; do **not** add
  a second provider.
- `@dataclass(frozen=True) class DetectionCandidate`: `index: int`,
  `target_type: str` (`habit|practice`), `target_id: int`, `name: str`. The
  caller (issue 03) builds these; this module treats them opaquely.
- `@dataclass(frozen=True) class CompletionDetected`: the resolved hit —
  `target_type`, `target_id`, `label` (sanitized candidate name),
  `anchor_start`, `anchor_end`, `anchor_text`.
- `build_detection_prompt(body, candidates) -> str`: render the candidates as a
  numbered list (`0) Daily run`, `1) Morning sit`, …) and ask the model to
  return STRICT JSON `{"hits": [{"candidate": <int>, "quote": "<verbatim>"}]}`,
  one entry per habit/practice the writer **did or completed** in this entry.
  Spell out the discriminator: include only clear evidence of *doing*
  ("I ran 5k this morning", "did my sit"), **never** intentions, plans, wishes,
  or avoidance ("I should run", "I keep skipping it", "tomorrow I'll meditate").
  Quote must be a verbatim substring (≤ `ANCHOR_TEXT_MAX`).
- Defensive parsing: `_load_hits(raw)` → `[]` on any malformed JSON (copy
  `_load_notes`); each item needs an int `candidate` and a str `quote`.
- `_resolve(body, candidates_by_index, item) -> CompletionDetected | None`:
  reject if `candidate` not an in-range index; resolve the quote span via the
  existing verbatim-find logic (reuse/duplicate `_quote_span` semantics);
  sanitize the candidate `name` into `label` (`sanitize_user_text`, drop on
  overflow). Return None on any failure.
- `async detect_completions(body, *, candidates, llm, max_hits=5) ->
  list[CompletionDetected]`: build prompt, complete, parse, resolve each,
  drop overlapping spans (first wins — reuse the `_overlaps`/`_overlaps_any`
  approach), de-dupe so the **same `target_id` is suggested at most once**, cap
  at `max_hits`. Empty `candidates` ⇒ return `[]` **without** calling the LLM
  (cost guard — the endpoint relies on this).

Add named constants (`MAX_HITS = 5`, reuse `ANCHOR_TEXT_MAX`/`sanitize` from
the resonance/ security modules) — no magic numbers.

## Tasks — tests (`backend/tests/test_detection_service.py`)

Use a fake LLM returning canned JSON (copy the `test_resonance_service.py`
fixture style):

- A hit whose `candidate` index and `quote` resolve → one `CompletionDetected`
  with the right `target_id`/`target_type` and a span matching `body.find`.
- Out-of-range `candidate` index dropped; quote-not-in-body dropped; malformed
  JSON ⇒ `[]`; non-string quote / non-int candidate dropped.
- Two hits for the **same** `target_id` collapse to one; overlapping spans
  de-dupe; result capped at `MAX_HITS`.
- `candidates=[]` ⇒ `[]` and the fake LLM's `complete` is **never awaited**
  (assert call count 0).
- A prompt-content test: `build_detection_prompt` lists every candidate with its
  index and instructs "did/completed, not planned".
- Enum-set guard: the module's valid `target_type` set matches the model enum
  (mirror the resonance enum-drift guard).

## Acceptance criteria

- [ ] `detect_completions` returns anchored, validated, de-duped hits and never
      trusts model ids/offsets; empty candidates short-circuit with no LLM call.
- [ ] Discriminator prompt excludes intentions/avoidance; AI `label` sanitized.
- [ ] New tests pass; `./scripts/backend/check-all.sh` green; pure module (no DB
      / FastAPI imports), A-grade complexity like `resonance.py`.

## Files

| File | Action |
|------|--------|
| `backend/src/domain/detection.py` | New — detection domain |
| `backend/tests/test_detection_service.py` | New — fake-LLM unit tests |

## Constraints

- Same trust + sanitation model as `domain/resonance.py`; reuse its `ResonanceLLM`
  seam and quote-span/overlap helpers rather than forking the provider.
- Keep it pure: inject the LLM, take candidates as plain dataclasses, return
  dataclasses. DB lookups and persistence belong to issues 03/04.
