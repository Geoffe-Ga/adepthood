"""Re-anchor margin notes after a journal entry's body changes.

Pure string logic — no LLM, no DB. A note re-anchors to its span if its snapshot
``anchor_text`` still exists in the new body; otherwise it is marked stale. Notes
are never deleted on edit.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ReanchorResult:
    """Outcome of re-anchoring one note: new span + whether it went stale."""

    anchor_start: int
    anchor_end: int
    stale: bool


def reanchor_one(anchor_text: str, anchor_start: int, new_body: str) -> ReanchorResult:
    """Re-locate ``anchor_text`` in ``new_body``.

    - Fast path: if the old offsets still spell ``anchor_text``, keep them.
    - Else the **first** occurrence of ``anchor_text`` becomes the new span
      (documented choice; duplicate passages anchor to the earliest match).
    - Empty ``anchor_text`` or no occurrence → stale, offsets left unchanged.
    """
    if not anchor_text:
        return ReanchorResult(anchor_start, anchor_start, stale=True)
    end = anchor_start + len(anchor_text)
    if anchor_start >= 0 and new_body[anchor_start:end] == anchor_text:
        return ReanchorResult(anchor_start, end, stale=False)
    found = new_body.find(anchor_text)
    if found != -1:
        return ReanchorResult(found, found + len(anchor_text), stale=False)
    return ReanchorResult(anchor_start, end, stale=True)
