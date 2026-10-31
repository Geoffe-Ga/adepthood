"""Withhold a restricted passage wherever a folded quote carried it (#3059, owner decision R5-2).

The owner decided (R5-2, ``prompts/claude-comms/2026-10-27-release-decisions.md``)
that Intimate text is excluded from folded quotes. A folded quote reaches the
server twice: as the ``PromotedQuote`` row, and as plaintext the client spliced
into a review's body as a Markdown blockquote -- every line of the quote
prefixed ``> `` (``frontend/src/features/Journal/reflectionCopy.ts``
``formatBlockquote``). The second copy is the one that egresses, inside a body
with its own, wider tier.

This module is the pure half of excluding it: given a body and the passages
that must not leave in it, :func:`withhold_passages` returns the body with each
of them masked with :data:`WITHHELD_MARK`, and :func:`span_overlaps_passage`
says whether a code-point span of a body touches one. Which passages are
restricted is a database question, answered by
:mod:`services.folded_quote_privacy`.

**Matching is by line, and it errs towards withholding.** A passage is matched
one stripped line at a time, so the ``> `` prefix the blockquote adds between
lines never hides a multi-line passage. Every occurrence of a line is
withheld, not only the one the fold put there: when the same words also appear
elsewhere in the body, sending them would send the passage. Prose the writer
retyped by hand is not a fold and is out of reach here, as it is for the
lineage resolver.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Final

#: What each code point of a withheld passage becomes in the body that egresses.
#: Content-free, so it is safe in a prompt, an index and a log alike.
#:
#: **Length-preserving on purpose.** A reflection pass and completion detection
#: anchor what the model quotes back by code-point offsets into the body they
#: sent, and those offsets are persisted against the writer's real page. A mask
#: of the same length keeps every offset outside the passage pointing at the
#: same words; a shorter marker would shift every anchor after it. The cost is
#: that a recipient learns how long the withheld passage was, never what it said.
WITHHELD_MARK: Final = "\u2591"


def _mask(line: str) -> str:
    """``line`` as :data:`WITHHELD_MARK`, one mark per code point."""
    return WITHHELD_MARK * len(line)


def passage_lines(passages: Iterable[str]) -> tuple[str, ...]:
    """The distinct, non-blank stripped lines of ``passages``, longest first.

    Longest first, so a line that contains a shorter one is masked whole rather
    than in pieces around the shorter one's mask.
    """
    lines = {line.strip() for passage in passages for line in passage.splitlines()}
    lines.discard("")
    return tuple(sorted(lines, key=lambda line: (-len(line), line)))


def withhold_passages(body: str, passages: Iterable[str]) -> str:
    """``body`` with every occurrence of every line of ``passages`` masked, length for length.

    An empty ``passages`` returns ``body`` unchanged; the result is always
    exactly as long as ``body`` (see :data:`WITHHELD_MARK`).
    """
    for line in passage_lines(passages):
        body = body.replace(line, _mask(line))
    return body


def carries_passage(text: str, passages: Iterable[str]) -> bool:
    """Whether ``text`` holds a line of ``passages``, or a line of it lies inside one.

    The second arm catches a quote lifted from *inside* a restricted passage:
    its text holds no whole line of the passage, but every word of it is one.
    """
    lines = passage_lines(passages)
    return any(line in text for line in lines) or _lies_inside(text, lines)


def _lies_inside(text: str, lines: tuple[str, ...]) -> bool:
    """Whether some line of ``text`` is a substring of one of ``lines``."""
    own = passage_lines((text,))
    return any(fragment in line for fragment in own for line in lines)


def span_overlaps_passage(body: str, start: int, end: int, passages: Iterable[str]) -> bool:
    """Whether the code-point span ``[start, end)`` of ``body`` touches a passage line anywhere."""
    for line in passage_lines(passages):
        found = body.find(line)
        while found != -1:
            if found < end and start < found + len(line):
                return True
            found = body.find(line, found + 1)
    return False
