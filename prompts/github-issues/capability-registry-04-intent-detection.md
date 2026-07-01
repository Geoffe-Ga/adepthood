# capability-registry-04: Registry-driven intent detection (verbs + params)

**Labels:** `enhancement`, `architecture`, `backend`, `capability-registry`
**Epic:** [The Capability Registry](capability-registry-epic.md)
**Depends on:** 01, 03
**Estimated LoC:** ~300

## Role

You are the engineer generalizing the detection pass
(`backend/src/domain/detection.py`) from "which habits/practices did the writer
complete" to "which capability verbs did the writer attest to" — **without
weakening the index+quote trust model**.

## Goal

Let a journal entry drive *any* registered capability. Candidates are gathered
from the `CapabilityRegistry` across enabled features; the LLM returns, per hit,
an **index** into the server's candidate list, a **verb** chosen from that
candidate's allowed verbs, a **verbatim quote**, and an optional **params**
object — all validated server-side against the capability's `extra="forbid"`
params schema. Hits become `ActionSuggestion` rows (03).

## Context

`domain/detection.py` builds a numbered candidate prompt and parses
`{"hits": [{"index", "quote"}]}`, resolving index → real row and anchoring the
quote itself (`detection.py:68-207`). `services/completion_candidates.py` gathers
habit+practice candidates under a shared budget (`MAX_CANDIDATES = 25`). This
issue widens both to the registry while keeping the exact resolution/anchoring
discipline.

## Tasks

1. **Generalize candidate gathering** into
   `backend/src/services/capability_candidates.py`: iterate `REGISTRY.all()`,
   skip capabilities whose `feature_flag` is disabled for the user (02), call
   each capability's `candidate_source` to append `DetectionCandidate`s carrying
   `capability_key` + `target_type` + `target_id` + `name` + `allowed_verbs`.
   Preserve the shared `MAX_CANDIDATES` budget and stable ordering.
2. **Extend the prompt + parser** in `detection.py`:
   - Candidate lines list the allowed verbs per index.
   - Response schema becomes
     `{"hits": [{"index", "verb", "quote", "params"?}]}`.
   - Resolution: index must address a real candidate; `verb` must be in that
     candidate's allowed set; `params` must validate against the capability's
     params model (drop the hit on any failure — same "drop if it doesn't
     resolve" rule as today). Quote anchored by the server; model offsets ignored.
   - Keep `MAX_HITS`, de-dup by `(capability_key, target_id, verb)`, overlap
     rejection.
3. **Route the resonance pass** (`routers/journal.py:584-633`) to persist
   `ActionSuggestion` rows from generalized hits. The habit/practice path now
   flows through this generic detector.
4. **Retain guardrails:** `MEDICATION_GUARDRAIL` stays in the prompt; if
   `assess_distress` fires, suppress action hits in favour of care resources
   (preserve current behaviour).
5. **Tests:** existing detection tests pass (habit/practice `complete` still
   works); new tests for verb selection, params validation + rejection, and a
   non-completion capability (`wheel`/`note`).

## Acceptance Criteria

- [ ] Detection proposes verbs+params only from the server-supplied menu; free-form model targets/offsets are never trusted.
- [ ] Existing habit/practice completion detection behaviour + tests unchanged.
- [ ] A newly-registered capability appears as a candidate with zero edits to `detection.py`.
- [ ] Disabled features contribute no candidates.
- [ ] `pytest backend/` + `pre-commit run --all-files` green; coverage unchanged.

## Files

| File | Action |
|------|--------|
| `backend/src/domain/detection.py` | Modify |
| `backend/src/services/capability_candidates.py` | **Create** (generalizes `completion_candidates.py`) |
| `backend/src/routers/journal.py` | Modify |
| `backend/tests/test_detection_service.py` | Modify |
| `backend/tests/test_capability_candidates.py` | **Create** |

## Constraints

- The prompt's verb/params menu is closed and server-authored; the model selects,
  never invents. Params schema is `extra="forbid"`.
- Keep the prompt-cost bound (`MAX_CANDIDATES`, truncation) so a user with many
  capabilities can't blow the token budget.
- Do not regress the atomic wallet-charge/resonance semantics of the endpoint.
