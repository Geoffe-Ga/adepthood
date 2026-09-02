"""Classify content into the APTITUDE frequency ontology, refusing INTIMATE.

Two properties carry this module, and both are structural rather than advisory.

**INTIMATE never reaches a cloud provider.** The refusal happens before the
provider layer is touched at all — not before the request is sent, but before
the call is even constructed — mirroring :mod:`services.creek_vault_write`,
which short-circuits an intimate entry ahead of the vault handshake. A guard
placed after a request was built would be correct today and one refactor away
from leaking.

**A failed classification is not a failed write.** Everything that can go wrong
with a provider — absent key, timeout, malformed reply, a frequency code
outside the ontology — degrades to :data:`UNCLASSIFIED`. Classification
enriches a corpus; it must never be why someone's journal entry fails to save.
Two conditions are raised rather than degraded, and neither is a way of failing
to recognise something. :class:`IntimateContentRefusedError` is a defect at the
call site rather than a runtime condition. :class:`services.botmason.\
LLMCreditExhaustedError` is a fact about the *deployment* rather than about this
call or this content: every degrade named above is true of one attempt and says
nothing about the next, whereas a spent balance is true of every call that
follows it until somebody settles a bill. A caller classifying one piece of
writing may treat that as :data:`UNCLASSIFIED` and lose nothing; a caller
classifying in bulk has to be able to stop, which it cannot do if the condition
arrives wearing the same face as a dropped socket.

**A caller with a deadline can impose one.** ``timeout_seconds`` bounds the
whole provider interaction rather than one attempt of it: ``services.botmason``
retries a transient failure twice, with backoff, on top of a per-attempt
timeout of its own, so a caller who has promised somebody an answer inside a
fixed number of seconds cannot get one by asking the provider layer nicely --
the bound has to cancel whatever that layer is in the middle of. Running out of
time is one more way to recognise nothing, so it degrades like the rest. The
default is no bound at all, which is what an interactive write wants: there,
the only clock that matters is the client's own.

**This is the floor, not the authority.** A user running their own Creek Vault
has it classify their corpus, and its answer wins; ``services.frequency_source``
is where that precedence rule lives and it is the only module that knows about
both sides. Nothing here imports the vault seam, and a test pins that: the
dependency runs selector to classifier and never back, so a deployment with no
vault at all still gets a classifier that does not know one exists. What this
module does owe the rule is its half of the record --
:class:`ClassificationSource`, so a stored classification can say afterwards
which side produced it.

Weighting is by conviction, not length: a short, certain assertion outweighs a
long, hedged one. That judgement belongs to the model, so the prompt says so —
and the parser preserves whatever weights come back rather than normalising
them into a distribution, since normalising would destroy exactly the signal
``overall_confidence`` carries.
"""

from __future__ import annotations

import asyncio
import enum
import json
import logging
import re
from dataclasses import dataclass
from types import MappingProxyType

from domain.frequencies import Frequency, frequency_table
from models.journal_entry import JournalClassification
from services.botmason import (
    LLMCreditExhaustedError,
    LLMProviderError,
    LLMResponse,
    generate_response,
)

logger = logging.getLogger(__name__)

# What the log calls a spent balance seen from here.
#
# A distinct event name rather than another `_degraded` reason, because it is a
# distinct kind of fact: `frequency_classification_degraded` records that one
# piece of writing was not placed, and this records that nothing will be until
# an operator acts. It is WARNING for the same reason
# ``botmason.credit_exhausted_error`` logs the server-key branch at WARNING --
# this path never threads a caller's own key, so the only person who can settle
# the bill is reading server logs.
CREDIT_EXHAUSTED_EVENT = "frequency_classification_credit_exhausted"

# The per-fragment cost ceiling, in characters of input.
#
# A corpus is classified fragment by fragment, so anything unbounded here is
# multiplied by the size of somebody's journal. Cost tracks the input: the reply
# is a small JSON object regardless of how much was sent. Roughly 4 chars per
# token by the same heuristic ``botmason._dynamic_max_tokens`` uses, so this is
# about 2k tokens -- comfortably more than a long journal entry, and a hard stop
# well before a pasted book.
#
# Content over the ceiling is classified on its opening rather than refused: a
# fragment's frequency is usually established early, and returning UNCLASSIFIED
# for long entries would quietly exclude the most substantial writing in a
# corpus from the ontology.
MAX_FRAGMENT_CHARS = 8_000

# Weights outside this range are a malformed reply, not a strong opinion.
_MIN_WEIGHT = 0.0
_MAX_WEIGHT = 1.0

# Models wrap JSON in prose or fences even when told not to, so this finds the
# outermost object rather than trusting the whole reply to parse.
_JSON_OBJECT = re.compile(r"\{.*\}", re.DOTALL)

_VALID_CODES = frozenset(code.value for code in Frequency)

SYSTEM_PROMPT = f"""You classify a fragment of writing into the APTITUDE frequency ontology.

The ontology is exactly these ten frequencies. Never invent an eleventh, and
never rename one:

{frequency_table()}

Weight by conviction, not by length. A three-word phrase confidently asserting
one frequency outweighs a five-hundred-word passage dimly hedging another. A
fragment may carry several frequencies at once, or none.

Reply with JSON and nothing else, in exactly this shape:

{{"weights": {{"F1": 0.7, "F3": 0.5}}, "overall_confidence": 0.8}}

Include only the frequencies actually present -- omit the rest rather than
listing them at zero. Every weight and the overall confidence are between 0.0
and 1.0. If the fragment carries no frequency clearly, reply with empty weights
and an overall_confidence of 0.0."""


class IntimateContentRefusedError(Exception):
    """Raised when classification is asked for INTIMATE-tier content.

    Not a degradation. Reaching this means a caller tried to route the most
    sensitive tier to a cloud provider, which is a defect in the caller, so it
    is raised loudly enough to fail a test rather than logged and forgotten.
    """


class ClassificationSource(enum.StrEnum):
    """Which side produced a classification.

    Two independent models can answer "what frequency is this" for the same
    fragment -- the user's own Creek Vault, and this operator-side classifier --
    and :mod:`services.frequency_source` decides which of them wins. This is the
    record of which one actually did, because after the fact the two answers are
    indistinguishable: both are weights over the same ten codes.

    ``NONE`` is not a missing value. It is the positive statement that *nobody*
    classified this fragment -- what :data:`UNCLASSIFIED` carries -- which is a
    different fact from an operator-side model having read the fragment and
    recognised nothing in it. Values are lowercase words because they are
    destined for a column and a log field, not for display.
    """

    VAULT = "vault"
    OPERATOR = "operator"
    NONE = "none"


@dataclass(frozen=True)
class FrequencyClassification:
    """Per-frequency weights, how sure the classifier was, and which one it was.

    ``weights`` omits frequencies the fragment does not carry rather than
    listing them at zero, so an empty mapping means "nothing recognised".
    Deliberately not normalised to sum to one: conviction is the quantity of
    interest, and a fragment carrying two frequencies strongly is not the same
    as one carrying them weakly.

    ``source`` has no default on purpose. Every classification carries
    provenance, and a default would let a path added later attribute the vault's
    answer to this module -- silently, and unrecoverably once the row is stored.
    """

    weights: MappingProxyType[Frequency, float]
    overall_confidence: float
    source: ClassificationSource

    def is_classified(self) -> bool:
        """Whether any frequency was recognised at all."""
        return bool(self.weights)


#: What every failure degrades to. One shared immutable instance: a caller that
#: needs to tell "nothing recognised" from "the provider was down" wants the
#: log line, not a distinguishable sentinel.
UNCLASSIFIED = FrequencyClassification(
    weights=MappingProxyType({}),
    overall_confidence=0.0,
    source=ClassificationSource.NONE,
)


def _coerce_weight(raw: object) -> float | None:
    """Return ``raw`` as an in-range weight, or ``None`` if it is not one.

    ``bool`` is rejected explicitly: it is a subclass of ``int`` in Python, so
    ``True`` would otherwise sail through as the weight ``1.0``.
    """
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return None
    value = float(raw)
    if value < _MIN_WEIGHT or value > _MAX_WEIGHT:
        return None
    return value


def _parse_weights(raw_weights: object) -> MappingProxyType[Frequency, float] | None:
    """Parse the ``weights`` object, rejecting anything outside the ontology.

    An unrecognised code fails the whole parse rather than being skipped. The
    vocabulary is contractual, so a reply naming ``F11`` means this side and the
    model disagree about the ontology -- dropping that key while keeping the
    rest is how a shared vocabulary drifts apart quietly.
    """
    if not isinstance(raw_weights, dict):
        return None
    parsed: dict[Frequency, float] = {}
    for code, raw_value in raw_weights.items():
        if code not in _VALID_CODES:
            return None
        weight = _coerce_weight(raw_value)
        if weight is None:
            return None
        parsed[Frequency(code)] = weight
    return MappingProxyType(parsed)


def _load_json_object(text: str) -> dict[str, object] | None:
    """Extract the outermost JSON object from a reply, or ``None``.

    Split out from :func:`_parse_reply` to keep both inside the repo's
    A-grade complexity budget, and because "find the JSON" and "interpret the
    JSON" fail for unrelated reasons.
    """
    match = _JSON_OBJECT.search(text)
    if match is None:
        return None
    try:
        payload = json.loads(match.group())
    except json.JSONDecodeError:
        return None
    return payload if isinstance(payload, dict) else None


def _parse_reply(text: str) -> FrequencyClassification | None:
    """Turn a model reply into a classification, or ``None`` if it is unusable."""
    payload = _load_json_object(text)
    if payload is None:
        return None
    weights = _parse_weights(payload.get("weights"))
    confidence = _coerce_weight(payload.get("overall_confidence"))
    if weights is None or confidence is None:
        return None
    return FrequencyClassification(
        weights=weights,
        overall_confidence=confidence,
        source=ClassificationSource.OPERATOR,
    )


def _degraded(reason: str) -> FrequencyClassification:
    """Record why nothing was recognised and return the empty classification.

    One place, so a new way of failing cannot arrive with a different shape of
    log line and become invisible to whoever is reading them.
    """
    logger.info("frequency_classification_degraded", extra={"reason": reason})
    return UNCLASSIFIED


async def _reply_within(
    content: str, *, api_key: str | None, timeout_seconds: float | None
) -> LLMResponse:
    """Ask the provider for a classification, abandoning it at the bound.

    ``asyncio.wait_for`` cancels the *whole* call, so a caller's bound covers
    the retries and the backoff sleeps inside it as well as the attempt in
    flight -- which is the only placement that bounds anything, since the
    retry ladder is where the time actually goes. Nothing but an outbound HTTP
    request is cancelled here: the sweep's database work stays outside, because
    a cancellation mid-statement would take the caller's open transaction with
    it and lose the fragments already written.
    """
    call = generate_response(
        user_message=content[:MAX_FRAGMENT_CHARS],
        conversation_history=[],
        system_prompt=SYSTEM_PROMPT,
        api_key=api_key,
    )
    if timeout_seconds is None:
        return await call
    return await asyncio.wait_for(call, timeout_seconds)


def _classification_of(response: LLMResponse) -> FrequencyClassification:
    """The position this reply names, or the degraded one if it names none usably.

    Separated from :func:`classify_frequencies` so that reading it is reading
    the four ways a provider interaction ends, one per handler, with the
    reply-shaped failure kept where the other shape-shaped failures already are.
    """
    parsed = _parse_reply(response.text)
    if parsed is None:
        return _degraded("unparsable_reply")
    return parsed


async def classify_frequencies(
    content: str,
    *,
    classification: JournalClassification,
    api_key: str | None = None,
    timeout_seconds: float | None = None,
) -> FrequencyClassification:
    """Classify ``content`` into the frequency ontology.

    Raises :class:`IntimateContentRefusedError` for INTIMATE content, before any
    provider call is constructed, and re-raises
    :class:`services.botmason.LLMCreditExhaustedError` after logging which
    provider refused. Every other failure -- no key, a transient provider
    failure, a timeout, a malformed reply, a code outside the ontology --
    returns :data:`UNCLASSIFIED`.

    The carve-out is narrow on purpose. A spent balance is the one provider
    condition that says something about every call after this one rather than
    about this one, so a caller working through a batch has to be able to stop
    paying for a refusal it has already been given. Callers that classify a
    single piece of writing may treat it as :data:`UNCLASSIFIED` and lose
    nothing by doing so.

    ``api_key`` is the caller's own key (BYOK), threaded to
    :func:`services.botmason.generate_response` exactly as the chat path does;
    ``None`` falls back to the server-side key.

    ``timeout_seconds`` is a hard ceiling on the provider interaction as a
    whole, for a caller that has a wall-clock promise to keep;
    :mod:`services.corpus_backfill` is the one that does. ``None`` -- the
    default, and what every interactive write passes -- leaves the provider
    layer's own timeout and retry budget in charge.
    """
    if classification is JournalClassification.INTIMATE:
        raise IntimateContentRefusedError
    try:
        response = await _reply_within(content, api_key=api_key, timeout_seconds=timeout_seconds)
    except LLMCreditExhaustedError as exc:
        # Ordered ahead of the base type or it would never be reached: the
        # subclass exists precisely so this condition keeps its identity past a
        # handler written for a dropped socket.
        logger.warning(CREDIT_EXHAUSTED_EVENT, extra={"provider": exc.provider})
        raise
    except LLMProviderError:
        return _degraded("provider_error")
    except TimeoutError:
        return _degraded("timed_out")
    return _classification_of(response)
