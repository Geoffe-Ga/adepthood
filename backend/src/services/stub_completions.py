"""What the stub provider answers when a prompt asks for a structured reply.

``BOTMASON_PROVIDER`` defaults to ``stub``, so every environment without a key
— local development, the backend suite, and the end-to-end lane, which drives a
real server over a real socket — reaches this module rather than a third party.
A single canned prose sentence is a fine answer to a chat turn, but the
resonance prompt asks for strict JSON carrying quotes copied out of the entry,
and prose answers that question with garbage: the completion does not parse, the
pass keeps nothing, and the anchored half of the feature has no path any test
without a network can walk.

So the stub answers the question it was actually asked. A resonance prompt gets
a reading whose quote is lifted verbatim out of the entry. A completion prompt
gets conservative hits only for explicit "did/completed/finished/practiced"
phrasing followed by a supplied candidate name. Both paths return model-shaped
JSON, while the domain still resolves every candidate and anchor itself.

An essay prompt gets a short letter quoting the passage it expands. That one is
not a convenience: the canned sentence quotes its whole input, so on the essay
path -- the only surface that renders a completion as prose -- the default
provider handed the writer the app's own prompt, medication guardrail included,
as their reflection (issue #2762). ``domain.resonance`` now refuses such a
completion, and a stub that only ever produced refusals would leave the default
developer experience exercising the failure branch and nothing else.

Nothing here weakens a boundary. The stub is selected by configuration, never
by a test import; an intimate entry still returns from the privacy floor before
any provider is constructed; and stub traffic still reports zero tokens.
"""

from __future__ import annotations

import json
import re

from domain.resonance import ANCHOR_TEXT_MAX, ESSAY_TASK_INSTRUCTION, MARGINALIA_JSON_SHAPE

# The entry the resonance prompt wants read, as ``build_prompt`` wraps it. The
# canned reading is built from this text rather than from the whole prompt, so
# the quote it returns is a substring of the body the domain will anchor
# against and not of the instructions surrounding it.
_ENTRY_BLOCK = re.compile(r"<entry>\n(?P<body>.*?)\n</entry>", re.DOTALL)

# The passage an essay prompt asks to be expanded, as ``_build_essay_prompt``
# wraps it. The canned letter quotes this rather than the whole prompt, which is
# the entire difference between a letter and the disclosure of #2762.
_PASSAGE_BLOCK = re.compile(r"<passage>\n(?P<passage>.*?)\n</passage>", re.DOTALL)

# Completion detection has its own plainly delimited candidate/entry blocks.
# Keep these tied to ``domain.detection.build_detection_prompt`` through tests;
# returning ``None`` on drift is safer than pretending an ordinary chat is a
# structured answer.
_DETECTION_BLOCK = re.compile(
    r"Candidates:\n(?P<candidates>.*?)\n\nEntry:\n(?P<body>.*?)\n\nReturn JSON: \{\"hits\":",
    re.DOTALL,
)
_CANDIDATE_LINE = re.compile(r"^(?P<index>\d+)\. (?P<name>.+) \((?:habit|practice)\)$")
_COMPLETION_VERBS = ("did", "completed", "finished", "practiced")
_MAX_DETECTION_HITS = 5

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


#: The fixed half of the canned letter, following the quoted passage. Second
#: person, no self-reference, no headings and no JSON
#: -- the same rules the essay prompt puts on a real model -- and, critically,
#: none of ``domain.resonance.PROMPT_ECHO_MARKERS``, so what the stub produces
#: is a letter the guard publishes rather than one it refuses. It quotes the
#: passage verbatim, which is both what a real letter does and the case that
#: proves the guard does not refuse a writer's own words handed back to them.
_CANNED_LETTER_BODY = (
    "Read that back slowly. You set it down and moved on, the way people do with "
    "the things they already know, and it deserves more of your attention than "
    "you gave it in the moment.\n\n"
    "Nothing here needs deciding today. Leave it where you can find it again, and "
    "come back to it when you are ready."
)


def _essay_completion(passage: str) -> str:
    """Return the canned letter expanding ``passage``, quoted verbatim.

    Composed with an f-string rather than ``str.format``: the passage is the
    writer's own prose, and a brace in it would make a format template raise.
    """
    return f"You wrote: \u201c{passage}\u201d\n\n{_CANNED_LETTER_BODY}"


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


def _detection_completion(candidates_block: str, body: str) -> str:
    """Return conservative, verbatim hits for explicitly completed candidates."""
    hits: list[dict[str, int | str]] = []
    for line in candidates_block.splitlines():
        candidate = _CANDIDATE_LINE.fullmatch(line)
        if candidate is None:
            continue
        name = candidate.group("name")
        verbs = "|".join(_COMPLETION_VERBS)
        attestation = re.compile(
            rf"\b(?:{verbs})\s+(?:my\s+|the\s+)?{re.escape(name)}\b", re.IGNORECASE
        )
        match = attestation.search(body)
        if match is None:
            continue
        hits.append({"index": int(candidate.group("index")), "quote": match.group(0)})
        if len(hits) == _MAX_DETECTION_HITS:
            break
    return json.dumps({"hits": hits})


def _canned_essay(user_message: str) -> str | None:
    """Return the canned letter for an essay prompt, or None if it carries no passage.

    Both halves of the marker are required, as on the marginalia side: a message
    naming the task but delimiting no passage is a shape this module does not
    recognise, and inventing a letter about nothing would be worse than
    declining to answer.
    """
    passage = _PASSAGE_BLOCK.search(user_message)
    return None if passage is None else _essay_completion(passage.group("passage"))


def _canned_marginalia(user_message: str) -> str | None:
    """Return the canned reading for a resonance prompt, or None if it is not one."""
    if MARGINALIA_JSON_SHAPE not in user_message:
        return None
    match = _ENTRY_BLOCK.search(user_message)
    return None if match is None else _marginalia_completion(match.group("body"))


def canned_completion(user_message: str) -> str | None:
    """Return the stub's structured answer to ``user_message``, else ``None``.

    ``None`` means "this prompt is none of this module's business" — a chat
    turn, or a structured shape it does not recognise — and keeps the canned
    sentence it has always had. Essay expansion used to fall in that bucket; it
    no longer does, because that sentence quotes its whole input (#2762).
    """
    detection = _DETECTION_BLOCK.search(user_message)
    if detection is not None:
        return _detection_completion(detection.group("candidates"), detection.group("body"))
    if ESSAY_TASK_INSTRUCTION in user_message:
        return _canned_essay(user_message)
    return _canned_marginalia(user_message)
