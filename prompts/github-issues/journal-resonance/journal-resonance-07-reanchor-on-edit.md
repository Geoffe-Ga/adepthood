# journal-resonance-07: Re-anchor marginalia on edit (re-anchor or mark stale)

**Labels:** `backend`, `enhancement`
**Epic:** [Journal Resonance](journal-resonance-epic.md)
**Depends on:** [journal-resonance-01](journal-resonance-01-marginalia-model.md), [journal-resonance-03](journal-resonance-03-patch-entry-endpoint.md)
**Estimated LoC:** ~200

## Role

You are a backend engineer implementing the rule for what happens to AI margin
notes when the user edits the page they're anchored to.

## Goal

When an entry's body changes, each note re-anchors to its span if the
`anchor_text` still exists in the new body, and is marked `stale` otherwise.
Notes are never silently deleted — stale notes are preserved (dimmed in the UI).
Fill in the `reanchor_entry_marginalia` seam that issue 03 left as a stub.

## Context

- Issue 03's `PATCH /journal/{id}` calls `reanchor_entry_marginalia(entry,
  old_body, new_body, session)` when the body changes (currently a no-op stub).
- Each `Marginalia` has `anchor_start`, `anchor_end`, `anchor_text`, `status`.

## Tasks

1. **Domain fn** `backend/src/domain/marginalia_anchoring.py`:
   - `reanchor_one(anchor_text, anchor_start, new_body) -> ReanchorResult`
     where the result is either `(active, new_start, new_end)` or `(stale, ...)`:
     - If `new_body[anchor_start : anchor_start + len(anchor_text)] ==
       anchor_text` → unchanged (fast path).
     - Else find the first occurrence of `anchor_text` in `new_body` → re-anchor
       to those offsets, keep `active`.
     - Else → `stale` (offsets left as-is).
   - Edge cases: empty `anchor_text` → stale; multiple occurrences → first match
     (documented choice).
2. **Wire** `reanchor_entry_marginalia(entry, old_body, new_body, session)`:
   - Load the entry's marginalia; apply `reanchor_one` to each; update offsets /
     `status` as needed; bump `updated_at`. Skip notes already `stale` (once
     stale, stay stale — they describe text that no longer exists).
   - Replace issue 03's stub with this real implementation.
3. **Tests** — `backend/tests/test_marginalia_reanchoring.py`:
   - Insert before the anchor → offsets shift, note stays `active`, `anchor_text`
     still indexes correctly.
   - Delete the anchored passage → note becomes `stale`.
   - Edit elsewhere, anchor text intact → note unchanged.
   - Duplicate anchor text → re-anchors to the first occurrence.
   - End-to-end through `PATCH /journal/{id}`: editing the body flips an affected
     note to `stale` and the `GET .../marginalia` reflects it.

## Acceptance Criteria

- [ ] Body edits re-anchor notes whose text survives and mark the rest `stale`.
- [ ] Stale notes are preserved (never deleted) and stay stale on further edits.
- [ ] `PATCH /journal/{id}` invokes the real re-anchor logic.
- [ ] `./scripts/backend/check-all.sh` green.

## Files to Create / Modify

| File | Action |
|------|--------|
| `backend/src/domain/marginalia_anchoring.py` | **Create** |
| `backend/src/routers/journal.py` | Modify (replace stub with real call) |
| `backend/tests/test_marginalia_reanchoring.py` | **Create** |

## Constraints

- Match on `anchor_text`, never offsets alone.
- Re-anchoring is best-effort and deterministic (first occurrence). Do not call
  the LLM here — this is pure string logic.
- Never delete marginalia on edit; staleness is the only downgrade.
