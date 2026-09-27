"""Re-anchor margin notes, suggestions and promoted quotes after a body edit.

Pure string logic -- no LLM, no DB, no logging. Every anchored row carries its
snapshot ``anchor_text`` and code-point offsets into the OLD body. An edit is
reduced to the single changed window between the old and new bodies (longest
common prefix, then longest common suffix), and each anchor is placed by where
that window falls:

- **Edit wholly after the anchor** -> keep the offsets.
- **Edit wholly before the anchor** -> shift both offsets by the net length
  change. Both hold by construction: the text before the window is the common
  prefix and the text after it is the common suffix.
- **Edit touches the anchor** (or the stored offsets do not spell the text) ->
  relocate only when the passage occurs exactly once in BOTH bodies; otherwise
  the row goes stale with its offsets unchanged.

A passage that repeats is never moved to "the first copy": that was a guess,
and it silently re-attached a quote or note to words it never marked. Requiring
uniqueness in the old body too is what guarantees the survivor is the anchor's
own copy rather than a sibling. Rows are never deleted on edit.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

# A passage is identifiable only when exactly this many copies exist; the scan
# probes one past it, which is enough to prove ambiguity without a full count.
_UNAMBIGUOUS_COUNT: Final = 1


@dataclass(frozen=True)
class ReanchorResult:
    """Outcome of re-anchoring one row: new span + whether it went stale."""

    anchor_start: int
    anchor_end: int
    stale: bool


def _common_prefix_len(a: str, b: str, limit: int) -> int:
    """Length of the common prefix of ``a`` and ``b``, capped at ``limit``."""
    n = 0
    while n < limit and a[n] == b[n]:
        n += 1
    return n


def _changed_window(old: str, new: str) -> tuple[int, int, int]:
    """Return ``(prefix, old_stop, delta)`` for the single edit turning old into new.

    ``old[prefix:old_stop]`` is the replaced span and ``delta`` is
    ``len(new) - len(old)``. The suffix is bounded by the shorter body minus the
    prefix, so on periodic text the prefix and suffix never overlap.
    """
    prefix = _common_prefix_len(old, new, min(len(old), len(new)))
    bound = min(len(old), len(new)) - prefix
    suffix = _common_prefix_len(old[::-1], new[::-1], bound)
    return prefix, len(old) - suffix, len(new) - len(old)


def _occurrences(needle: str, haystack: str, limit: int) -> list[int]:
    """Start offsets of ``needle`` in ``haystack`` (overlapping), at most ``limit``."""
    hits: list[int] = []
    found = haystack.find(needle)
    while found != -1 and len(hits) < limit:
        hits.append(found)
        found = haystack.find(needle, found + 1)
    return hits


def _unique_relocation(anchor_text: str, old_body: str, new_body: str) -> int | None:
    """The passage's new start when it is unique in both bodies, else ``None``."""
    probe = _UNAMBIGUOUS_COUNT + 1
    if len(_occurrences(anchor_text, old_body, probe)) != _UNAMBIGUOUS_COUNT:
        return None
    hits = _occurrences(anchor_text, new_body, probe)
    return hits[0] if len(hits) == _UNAMBIGUOUS_COUNT else None


def _window_position(start: int, end: int, old_body: str, new_body: str) -> int | None:
    """The anchor's new start when the edit window misses it, else ``None``."""
    prefix, old_stop, delta = _changed_window(old_body, new_body)
    if end <= prefix:
        return start
    if start >= old_stop:
        return start + delta
    return None


def _placed_start(anchor_text: str, start: int, old_body: str, new_body: str) -> int | None:
    """The anchor's start in ``new_body``, or ``None`` when it cannot be proven.

    Offsets that spell the text in ``old_body`` follow the edit window; when the
    edit touches them (or they have drifted), only a unique passage relocates.
    """
    end = start + len(anchor_text)
    if start >= 0 and old_body[start:end] == anchor_text:
        placed = _window_position(start, end, old_body, new_body)
        if placed is not None:
            return placed
    return _unique_relocation(anchor_text, old_body, new_body)


def reanchor_one(
    anchor_text: str, anchor_start: int, old_body: str, new_body: str
) -> ReanchorResult:
    """Place ``anchor_text`` (at ``anchor_start`` in ``old_body``) in ``new_body``.

    - Offsets that spell the text in ``old_body`` follow the edit window: kept
      when the edit is after the anchor, shifted by the net delta when before.
      At a boundary, an insertion at ``anchor_start`` shifts the anchor and an
      insertion at ``anchor_end`` keeps it (a boundary insert is outside it).
    - Otherwise (the edit touches the anchor, or the stored offsets have drifted)
      the anchor relocates only to a passage unique in both bodies.
    - Anything else -- empty ``anchor_text``, a vanished passage, or two or more
      candidate copies -- is stale, with offsets left unchanged. It never moves
      to another copy.

    Known limit: the prefix-greedy diff cannot tell which of two identical
    adjacent runs an edit changed (inserting "the " before "the willow"). The
    window then lands inside the anchor, so a repeated passage goes stale and a
    unique one relocates. The window is also one contiguous region: a save
    carrying two separate edits, one before and one after the anchor, marks
    the anchor as touched, with the same outcome. Offsets are Unicode code points (Python ``str``
    indices), the anchor API's unit.
    """
    if not anchor_text:
        return ReanchorResult(anchor_start, anchor_start, stale=True)
    placed = _placed_start(anchor_text, anchor_start, old_body, new_body)
    if placed is None:
        return ReanchorResult(anchor_start, anchor_start + len(anchor_text), stale=True)
    return ReanchorResult(placed, placed + len(anchor_text), stale=False)
