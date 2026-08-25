"""Resonance generation: turn a journal entry into anchored margin notes.

Pure domain logic with the LLM injected — no FastAPI, no DB. The model proposes
short notes with a verbatim ``quote`` from the body; we resolve each quote to
character offsets *ourselves* (never trusting model-supplied indices) and drop
anything that doesn't anchor cleanly.
"""

from __future__ import annotations

import json
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from enum import Enum
from typing import Protocol

from domain.care import MEDICATION_GUARDRAIL
from security import TextTooLongError, sanitize_user_text

# Kept as literals (not imported from models.marginalia) so the domain stays
# free of DB imports; ``test_resonance_service`` guards this against enum drift.
VALID_KINDS = frozenset({"theme", "connection", "symbol"})
ANCHOR_TEXT_MAX = 280
NOTE_MAX = 600
ESSAY_MAX = 10_000
_DEFAULT_MAX_NOTES = 5
# Bound the prompt cost: at most this many prior entries, each truncated, so a
# caller passing a long history can't blow up the context window / token bill.
MAX_PRIOR_ENTRIES = 5
_PRIOR_ENTRY_CHARS = 1000


class _AnchoredSpan(Protocol):
    """Structural type for anything carrying integer ``anchor_start`` / ``anchor_end``.

    Lets :func:`_overlaps` serve both :class:`MarginaliaAnchored` and the
    detection module's ``CompletionDetected`` without either importing the
    other's concrete type -- the half-open span check is identical for both.
    Both concrete types are frozen dataclasses, so the members are declared
    read-only to stay structurally compatible under strict typing.
    """

    @property
    def anchor_start(self) -> int:
        """Inclusive start offset of the span in the source text."""

    @property
    def anchor_end(self) -> int:
        """Exclusive end offset of the span in the source text."""


@dataclass(frozen=True)
class MarginaliaDraft:
    """A model-proposed note before anchoring: a kind, a verbatim quote, a note."""

    kind: str
    quote: str
    note: str


@dataclass(frozen=True)
class MarginaliaAnchored:
    """A note resolved to a character span of the entry body."""

    kind: str
    anchor_start: int
    anchor_end: int
    anchor_text: str
    note: str


class DropReason(Enum):
    """Why one model-proposed draft never reached the writer.

    The set is closed and each member names a *different* fault, because the
    remedy differs: ``UNANCHORABLE`` in bulk means the model is paraphrasing
    its quotes (a prompt problem), ``KIND`` in bulk means it is inventing
    categories (also a prompt problem), while ``OVERLAPPING`` in bulk means it
    is crowding one passage (a fine outcome, and not a failure at all).
    """

    #: The JSON item was not an object carrying string kind/quote/note.
    MALFORMED = "malformed"
    #: The ``kind`` is not one of :data:`VALID_KINDS`.
    KIND = "kind"
    #: The quote was not present verbatim in the body, so it could not anchor.
    UNANCHORABLE = "unanchorable"
    #: The note was empty or too long once sanitized.
    UNSANITISABLE = "unsanitisable"
    #: The span intersected a note already kept; first anchor wins.
    OVERLAPPING = "overlapping"


@dataclass(frozen=True)
class _ParsedCompletion:
    """What the model's raw completion yielded before anchoring was attempted."""

    #: The completion decoded to an object carrying a ``notes`` array.
    usable: bool
    #: How many entries that array held, well-shaped or not.
    proposed: int
    #: The well-shaped subset.
    drafts: list[MarginaliaDraft]


@dataclass(frozen=True)
class MarginaliaOutcome:
    """The notes a pass produced, plus an account of everything it discarded.

    A resonance pass that returns nothing used to be indistinguishable from a
    pass that was never going to: the caller saw an empty list and logged
    ``count=0``, which states the outcome and never the cause. This type is the
    cause. It carries counts only -- never a quote, a note, or any part of the
    entry -- because journal bodies are encrypted at rest and the surrounding
    code logs ids and counts for that reason.

    The counts reconcile: ``kept + every dropped count + unexamined ==
    proposed``. That is not decoration; it is what makes the record trustworthy,
    since a draft that fell out through some path nobody counted would show up
    as a gap in the arithmetic rather than as silence.
    """

    #: The anchored notes, in the order they were kept.
    notes: list[MarginaliaAnchored]
    #: False when the completion was not JSON carrying a ``notes`` array.
    completion_parsed: bool
    #: Entries in the model's ``notes`` array, well-shaped or not.
    proposed: int
    #: Well-shaped drafts actually put through anchoring (the rest hit the cap).
    examined: int
    #: How many drafts each fault discarded.
    dropped: Mapping[DropReason, int]
    #: Provider calls the pass made, i.e. 2 once the corrective retry ran.
    attempts: int = 1

    @property
    def kept(self) -> int:
        """How many notes reached the writer."""
        return len(self.notes)

    @property
    def unexamined(self) -> int:
        """Well-shaped drafts never looked at because ``max_notes`` was reached."""
        malformed = self.dropped.get(DropReason.MALFORMED, 0)
        return self.proposed - malformed - self.examined

    @property
    def produced_nothing_usable(self) -> bool:
        """True when the model said something and the writer received nothing.

        Deliberately false for the one benign shape -- a parsed completion whose
        ``notes`` array was empty -- because that is a model declining to
        comment, not a pipeline silently eating its own output.
        """
        return self.kept == 0 and (self.proposed > 0 or not self.completion_parsed)

    def as_log_extra(self) -> dict[str, int | bool]:
        """Return the counts as structured log fields (no text, ever).

        Keys are prefixed so they cannot collide with :class:`logging.LogRecord`
        attributes, and every drop reason is emitted even at zero so a dashboard
        can chart a reason that has stopped occurring.
        """
        extra: dict[str, int | bool] = {
            "completion_parsed": self.completion_parsed,
            "drafts_proposed": self.proposed,
            "drafts_kept": self.kept,
            "drafts_unexamined": self.unexamined,
            # Two attempts costs twice the tokens, so the retry rate is a bill
            # an operator must be able to chart, not a hidden doubling.
            "resonance_attempts": self.attempts,
        }
        extra.update(
            {f"dropped_{reason.value}": self.dropped.get(reason, 0) for reason in DropReason}
        )
        return extra


class ResonanceLLM(Protocol):
    """Minimal injected LLM seam: prompt in, raw completion text out."""

    async def complete(self, prompt: str) -> str: ...


def build_prompt(
    body: str, prior_entries: Sequence[str] | None = None, max_notes: int = _DEFAULT_MAX_NOTES
) -> str:
    """Build the structured prompt asking for up to ``max_notes`` margin notes.

    Leads with :data:`~domain.care.MEDICATION_GUARDRAIL`. The botmason adapter
    (:class:`services.marginalia.BotmasonResonanceLLM`) also injects the same
    guardrail at the system role, so it is intentionally present twice on this
    path (defense-in-depth) — do not "deduplicate" by removing either copy.
    """
    prior_block = ""
    if prior_entries:
        capped = [entry[:_PRIOR_ENTRY_CHARS] for entry in prior_entries[:MAX_PRIOR_ENTRIES]]
        joined = "\n---\n".join(capped)
        prior_block = (
            "\n\nEarlier entries (context for 'connection' notes only):\n"
            f"<prior>\n{joined}\n</prior>"
        )
    return (
        f"{MEDICATION_GUARDRAIL}\n\n"
        "You are a thoughtful reader leaving margin notes on someone's journal "
        "page. Read the entry and surface up to "
        f"{max_notes} of the most resonant observations.\n\n"
        "For each note:\n"
        '- "kind" is one of: theme, connection, symbol.\n'
        '- "quote" is a VERBATIM substring copied exactly from the entry '
        f"(<= {ANCHOR_TEXT_MAX} characters), never paraphrased.\n"
        '- "note" is 1-2 warm, second-person sentences spoken to the writer. '
        'Never refer to yourself or say "as an AI".\n'
        "- Use 'connection' only when linking to an earlier entry.\n\n"
        "Return STRICT JSON only, no prose, of the form:\n"
        '{"notes": [{"kind": "theme", "quote": "...", "note": "..."}]}\n\n'
        f"<entry>\n{body}\n</entry>{prior_block}"
    )


def _draft_from_item(item: object) -> MarginaliaDraft | None:
    """Build a draft from one parsed JSON item, or None if it's the wrong shape."""
    if not isinstance(item, dict):
        return None
    kind, quote, note = item.get("kind"), item.get("quote"), item.get("note")
    if isinstance(kind, str) and isinstance(quote, str) and isinstance(note, str):
        return MarginaliaDraft(kind=kind, quote=quote, note=note)
    return None


def _optional_json_list(raw: str, key: str) -> list[object] | None:
    """Parse ``raw`` JSON and return its ``key`` list, or None if there isn't one.

    The ``None`` matters: "the model returned an empty ``notes`` array" and "the
    completion was not usable JSON at all" are different events, and collapsing
    them into an empty list is what made a zero-note pass undiagnosable.
    """
    try:
        payload = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None
    value = payload.get(key) if isinstance(payload, dict) else None
    return value if isinstance(value, list) else None


def _load_json_list(raw: str, key: str) -> list[object]:
    """Parse ``raw`` JSON and return its ``key`` list; [] on any malformed input."""
    return _optional_json_list(raw, key) or []


def _parse_completion(raw: str) -> _ParsedCompletion:
    """Parse the model's JSON into drafts, keeping count of what it discarded.

    Never raises on bad input. An item of the wrong shape is dropped exactly as
    before, but is now counted rather than vanishing.
    """
    items = _optional_json_list(raw, "notes")
    if items is None:
        return _ParsedCompletion(usable=False, proposed=0, drafts=[])
    drafts = [draft for item in items if (draft := _draft_from_item(item)) is not None]
    return _ParsedCompletion(usable=True, proposed=len(items), drafts=drafts)


def _sanitize_note(note: str) -> str | None:
    """Sanitize a note; return None if it can't fit the column after sanitizing."""
    try:
        cleaned = sanitize_user_text(note, max_len=NOTE_MAX)
    except TextTooLongError:
        return None
    return cleaned or None


def _quote_span(body: str, quote: str) -> tuple[int, int] | None:
    """Locate ``quote`` verbatim in ``body``; return its offsets or None."""
    if not quote or len(quote) > ANCHOR_TEXT_MAX:
        return None
    start = body.find(quote)
    return None if start == -1 else (start, start + len(quote))


def _anchor(body: str, draft: MarginaliaDraft) -> MarginaliaAnchored | DropReason:
    """Resolve a draft to a span, or name the reason it could not be resolved.

    Returning the reason rather than a bare ``None`` is the whole point: three
    quite different faults used to leave through one exit, so a pass in which
    the model paraphrased every quote looked exactly like a pass in which it
    returned nothing.
    """
    if draft.kind not in VALID_KINDS:
        return DropReason.KIND
    span = _quote_span(body, draft.quote)
    if span is None:
        return DropReason.UNANCHORABLE
    note = _sanitize_note(draft.note)
    if note is None:
        return DropReason.UNSANITISABLE
    start, end = span
    return MarginaliaAnchored(
        kind=draft.kind,
        anchor_start=start,
        anchor_end=end,
        anchor_text=body[start:end],
        note=note,
    )


def _overlaps(a: _AnchoredSpan, b: _AnchoredSpan) -> bool:
    """True when two anchored spans intersect."""
    return a.anchor_start < b.anchor_end and b.anchor_start < a.anchor_end


def _overlaps_any(candidate: MarginaliaAnchored, kept: list[MarginaliaAnchored]) -> bool:
    """True when ``candidate`` overlaps any already-kept anchor."""
    return any(_overlaps(candidate, other) for other in kept)


def _anchor_drafts(body: str, parsed: _ParsedCompletion, max_notes: int) -> MarginaliaOutcome:
    """Anchor each draft against ``body``, tallying every one that is discarded.

    Anchoring stays exactly as strict as it was -- ``_quote_span`` still matches
    verbatim and model-supplied indices are still never trusted. The only change
    is that a discard is now recorded instead of being silently skipped.
    """
    kept: list[MarginaliaAnchored] = []
    dropped: Counter[DropReason] = Counter()
    dropped[DropReason.MALFORMED] = parsed.proposed - len(parsed.drafts)
    examined = 0
    for draft in parsed.drafts:
        if len(kept) >= max_notes:
            break
        examined += 1
        candidate = _anchor(body, draft)
        if isinstance(candidate, DropReason):
            dropped[candidate] += 1
        elif _overlaps_any(candidate, kept):
            dropped[DropReason.OVERLAPPING] += 1
        else:
            kept.append(candidate)
    return MarginaliaOutcome(
        notes=kept,
        completion_parsed=parsed.usable,
        proposed=parsed.proposed,
        examined=examined,
        dropped=dict(dropped),
    )


# Restated at the tail of the retry prompt (so the medication guardrail still
# leads) when the first attempt reached the writer with nothing. It names the
# one fault that actually causes this -- a paraphrased quote -- and closes the
# obvious wrong exit: a model told "you produced nothing" will happily invent
# something, and filler reflection on someone's journal is worse than silence.
_RETRY_CORRECTION = (
    'Your previous reply produced no usable notes. Every "quote" must be copied '
    "character-for-character from the entry above: do not paraphrase it, do not "
    "correct its spelling, do not add or remove punctuation, and do not join text "
    "from two places. If you cannot reproduce a passage exactly, leave that note "
    "out. Returning one exactly-quoted note beats five approximate ones, and an "
    "empty list is better than inventing an observation the entry does not support."
)


def _retry_prompt(body: str, prior_entries: Sequence[str] | None, max_notes: int) -> str:
    """Build the corrective second-attempt prompt: the same ask, plus the fix.

    Deliberately the *same* question with a correction appended rather than a
    different, easier one: the writer asked for a reading of this entry with
    this grounding, and quietly narrowing the ask would answer a question they
    did not put. The correction trails the entry so the medication guardrail
    still leads the prompt.
    """
    return f"{build_prompt(body, prior_entries, max_notes)}\n\n{_RETRY_CORRECTION}"


async def _one_pass(body: str, llm: ResonanceLLM, prompt: str, max_notes: int) -> MarginaliaOutcome:
    """Run one provider call and anchor whatever it returned."""
    raw = await llm.complete(prompt)
    return _anchor_drafts(body, _parse_completion(raw), max_notes)


async def generate_marginalia(
    body: str,
    *,
    llm: ResonanceLLM,
    prior_entries: Sequence[str] | None = None,
    max_notes: int = _DEFAULT_MAX_NOTES,
) -> MarginaliaOutcome:
    """Ask ``llm`` to read ``body`` and return anchored notes plus what was dropped.

    Quotes are located verbatim in ``body`` (model indices are never trusted);
    notes that don't anchor, have an unknown kind, or can't be sanitized are
    dropped. Overlapping spans are de-duplicated (first wins) and the result is
    capped at ``max_notes``.

    Returns a :class:`MarginaliaOutcome` rather than a bare list so a caller can
    tell an empty result apart from a pass that discarded everything it was
    given. Callers are expected to log :meth:`MarginaliaOutcome.as_log_extra`;
    dropping the outcome on the floor re-creates the silence this replaced.

    A pass that the model engaged with and that still reached the writer with
    nothing (:attr:`MarginaliaOutcome.produced_nothing_usable`) is asked exactly
    once more, with the verbatim-quote requirement restated. That is a re-ask,
    not a rescue: anchoring stays as strict, model indices stay untrusted, and
    the retry prompt says outright that an empty answer beats an invented one.
    A model that returned a well-formed empty array is *not* retried -- it read
    the page and declined, and a second call buys the same answer twice.
    """
    first = await _one_pass(body, llm, build_prompt(body, prior_entries, max_notes), max_notes)
    if not first.produced_nothing_usable:
        return first
    retry_prompt = _retry_prompt(body, prior_entries, max_notes)
    second = await _one_pass(body, llm, retry_prompt, max_notes)
    return replace(second, attempts=first.attempts + 1)


class NoNotesReason(Enum):
    """Why a completed pass reached the writer with no margin notes at all.

    Distinct from :class:`DropReason`, which names why one *draft* was
    discarded and is written for an operator. These name what the *writer*
    should do next, and there are exactly three next moves: write more, ask
    again, or wait a moment and ask again.
    """

    #: The model read the entry and had nothing to say yet.
    NOTHING_TO_ADD = "nothing_to_add"
    #: Notes were written but none quoted the entry closely enough to anchor.
    NOTHING_ANCHORED = "nothing_anchored"
    #: The completion never yielded a well-shaped note to anchor in the first place.
    UNREADABLE = "unreadable"


# The copy the writer actually reads when a pass yields nothing. It lives here,
# beside the reason that selects it, so the client renders the backend's own
# sentence instead of inventing a second explanation for a cause it cannot see.
# Each follows what / why / next / escape, and none of them says or implies the
# entry was inadequate: a journal is never wrong, and a tool that hints it might
# be has failed at the only thing this one is for.
NO_NOTES_MESSAGES: Mapping[NoNotesReason, str] = {
    NoNotesReason.NOTHING_TO_ADD: (
        "No margin notes came back this time. Your Higher Self read the page through "
        "and didn't find a passage it could answer yet — most often that means the "
        "thought is still arriving. Keep writing and ask again whenever you like; this "
        "pass wasn't charged."
    ),
    NoNotesReason.NOTHING_ANCHORED: (
        "No margin notes came back this time. Notes were written, but none of them "
        "quoted the page closely enough to pin to it, and a note that can't point at "
        "your own words isn't worth handing you. Asking again usually lands — the "
        "reading comes out a little different each time — and this pass wasn't charged."
    ),
    NoNotesReason.UNREADABLE: (
        "No margin notes came back this time. The reflection arrived in a shape this "
        "page couldn't read, which has nothing to do with what you wrote. Give it a "
        "moment and ask again; your entry is saved exactly as you left it, and this "
        "pass wasn't charged."
    ),
}


def _no_notes_reason(outcome: MarginaliaOutcome) -> NoNotesReason:
    """Classify a zero-note outcome by what the writer should do about it."""
    if not outcome.completion_parsed:
        return NoNotesReason.UNREADABLE
    if outcome.proposed == 0:
        return NoNotesReason.NOTHING_TO_ADD
    # Drafts existed but none was well-shaped enough to reach anchoring, so
    # anchoring is not what failed and must not be what the writer is told.
    if outcome.examined == 0:
        return NoNotesReason.UNREADABLE
    return NoNotesReason.NOTHING_ANCHORED


def explain_no_notes(outcome: MarginaliaOutcome) -> str | None:
    """Return the writer-facing sentence for a zero-note pass, else ``None``.

    ``None`` for any pass that kept a note: the notes are the answer, and a
    paragraph explaining them would be noise. Otherwise the writer always gets a
    sentence, because the alternative -- a button that visibly does nothing --
    is indistinguishable from a broken one, and is what was reported.
    """
    if outcome.kept > 0:
        return None
    return NO_NOTES_MESSAGES[_no_notes_reason(outcome)]


def _build_essay_prompt(body: str, anchor_text: str, kind: str, note: str) -> str:
    """Build the prompt expanding one margin note into a short letter-like essay.

    Leads with :data:`~domain.care.MEDICATION_GUARDRAIL`; the botmason adapter also
    injects it at the system role, so it is intentionally present twice on this
    path (defense-in-depth) — do not remove either copy.
    """
    return (
        f"{MEDICATION_GUARDRAIL}\n\n"
        "You are writing a short, warm letter to the person whose journal this is, "
        f"expanding on a margin note you left. Stay grounded in the passage you "
        f"anchored to; speak in second person; never refer to yourself as an AI.\n\n"
        f"Margin note kind: {kind}\n"
        f"Your margin note: {note}\n"
        f"The passage it anchors to:\n<passage>\n{anchor_text}\n</passage>\n\n"
        f"The full entry for context:\n<entry>\n{body}\n</entry>\n\n"
        "Write a few warm paragraphs. Plain prose only, no headings or JSON."
    )


def _sanitize_essay(text: str) -> str:
    """Sanitize + cap an essay to ESSAY_MAX, truncating rather than raising."""
    truncated = text[:ESSAY_MAX]
    try:
        return sanitize_user_text(truncated, max_len=ESSAY_MAX)
    except TextTooLongError:
        # NFC expansion pushed it back over the cap; trim with headroom.
        return sanitize_user_text(truncated[: ESSAY_MAX // 2], max_len=ESSAY_MAX)


async def generate_essay(
    *, llm: ResonanceLLM, body: str, anchor_text: str, kind: str, note: str
) -> str:
    """Ask ``llm`` to expand a margin note into a sanitized, length-capped essay."""
    raw = await llm.complete(_build_essay_prompt(body, anchor_text, kind, note))
    return _sanitize_essay(raw)
