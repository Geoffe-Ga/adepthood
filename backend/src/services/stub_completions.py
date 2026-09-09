"""What the stub provider answers when a prompt asks for a structured reply.

``BOTMASON_PROVIDER`` defaults to ``stub``, so every environment without a key
— local development, the backend suite, and the end-to-end lane, which drives a
real server over a real socket — reaches this module rather than a third party.
A single canned prose sentence is a fine answer to a chat turn, but the
resonance prompt asks for strict JSON carrying quotes copied out of the entry,
and prose answers that question with garbage: the completion does not parse, the
pass keeps nothing, and the anchored half of the feature has no path any test
without a network can walk.

So the stub answers the question it was actually asked. When the prompt is the
one :func:`domain.resonance.build_prompt` builds, this returns a reading whose
quote is lifted verbatim out of the entry that prompt carries, and the domain
anchors it exactly as it would a real model's — resolving the offsets itself,
trusting nothing the completion says about position. When the entry offers no
sentence to copy, the reading is a well-formed empty array: the stub will not
paraphrase, and a page it cannot quote is a page it has nothing to say about.
That is the same shape a real model's decline takes, which is what makes both
halves of the journey — a note in the margin, and an honest sentence saying why
there is none — reachable without a provider.

Nothing here weakens a boundary. The stub is selected by configuration, never
by a test import; an intimate entry still returns from the privacy floor before
any provider is constructed; and stub traffic still reports zero tokens.
"""

from __future__ import annotations

import json
import re

from domain.resonance import ANCHOR_TEXT_MAX, MARGINALIA_JSON_SHAPE

# The entry the resonance prompt wants read, as ``build_prompt`` wraps it. The
# canned reading is built from this text rather than from the whole prompt, so
# the quote it returns is a substring of the body the domain will anchor
# against and not of the instructions surrounding it.
_ENTRY_BLOCK = re.compile(r"<entry>\n(?P<body>.*?)\n</entry>", re.DOTALL)

#: One complete sentence: any run of text up to and including a terminator.
_SENTENCE = re.compile(r"[^.!?]*[.!?]")

#: The one kind the canned reading uses: it reads a single page, and
#: ``connection`` would claim a link to an earlier entry it was never shown.
_CANNED_KIND = "theme"

#: Second person, no self-reference, well inside the note length cap — the same
#: rules the prompt puts on a real model's note.
_CANNED_NOTE = (
    "You set this down plainly, and then moved past it. It is worth reading "
    "back slowly: it carries more than it says."
)


def _quotable_sentence(body: str) -> str | None:
    """Return ``body``'s LAST complete sentence verbatim, or ``None`` if it has none.

    The last rather than the first, deliberately: a page's first sentence begins
    at offset zero, so a fixture that always quotes it anchors at zero too, and
    then a span the persistence layer hard-coded to zero is indistinguishable
    from one it resolved correctly. A test written against such a fixture cannot
    fail on a mis-anchored note — which is the defect the anchoring exists to
    prevent. Quoting the closing sentence puts the span somewhere only real
    resolution can find. Do not "simplify" this back to the first sentence.

    Trimmed and capped at :data:`~domain.resonance.ANCHOR_TEXT_MAX`; both
    operations only narrow a contiguous slice, so what comes back is still a
    substring of ``body`` and still anchors.
    """
    sentences = _SENTENCE.findall(body)
    if not sentences:
        return None
    return sentences[-1].strip()[:ANCHOR_TEXT_MAX] or None


def _marginalia_completion(body: str) -> str:
    """Serialize the canned reading of ``body`` in the shape the prompt asks for."""
    sentence = _quotable_sentence(body)
    notes = (
        []
        if sentence is None
        else [{"kind": _CANNED_KIND, "quote": sentence, "note": _CANNED_NOTE}]
    )
    return json.dumps({"notes": notes})


def canned_completion(user_message: str) -> str | None:
    """Return the stub's structured answer to ``user_message``, else ``None``.

    ``None`` means "this prompt asked for prose", which is every prompt but the
    resonance one — chat turns, completion detection, essay expansion. Those
    keep the canned sentence they have always had.
    """
    if MARGINALIA_JSON_SHAPE not in user_message:
        return None
    match = _ENTRY_BLOCK.search(user_message)
    if match is None:
        return None
    return _marginalia_completion(match.group("body"))
