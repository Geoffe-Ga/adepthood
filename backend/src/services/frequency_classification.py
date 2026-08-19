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
The only exception raised from here is :class:`IntimateContentRefusedError`, which
is a defect at the call site rather than a runtime condition.

Weighting is by conviction, not length: a short, certain assertion outweighs a
long, hedged one. That judgement belongs to the model, so the prompt says so —
and the parser preserves whatever weights come back rather than normalising
them into a distribution, since normalising would destroy exactly the signal
``overall_confidence`` carries.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from types import MappingProxyType

from domain.frequencies import Frequency, frequency_table
from models.journal_entry import JournalClassification
from services.botmason import LLMProviderError, generate_response

logger = logging.getLogger(__name__)

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


@dataclass(frozen=True)
class FrequencyClassification:
    """Per-frequency weights plus how sure the model was overall.

    ``weights`` omits frequencies the fragment does not carry rather than
    listing them at zero, so an empty mapping means "nothing recognised".
    Deliberately not normalised to sum to one: conviction is the quantity of
    interest, and a fragment carrying two frequencies strongly is not the same
    as one carrying them weakly.
    """

    weights: MappingProxyType[Frequency, float]
    overall_confidence: float

    def is_classified(self) -> bool:
        """Whether any frequency was recognised at all."""
        return bool(self.weights)


#: What every failure degrades to. One shared immutable instance: a caller that
#: needs to tell "nothing recognised" from "the provider was down" wants the
#: log line, not a distinguishable sentinel.
UNCLASSIFIED = FrequencyClassification(
    weights=MappingProxyType({}),
    overall_confidence=0.0,
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
    return FrequencyClassification(weights=weights, overall_confidence=confidence)


async def classify_frequencies(
    content: str,
    *,
    classification: JournalClassification,
    api_key: str | None = None,
) -> FrequencyClassification:
    """Classify ``content`` into the frequency ontology.

    Raises :class:`IntimateContentRefusedError` for INTIMATE content, before any
    provider call is constructed. Every other failure -- no key, a timeout, a
    malformed reply, a code outside the ontology -- returns
    :data:`UNCLASSIFIED`.

    ``api_key`` is the caller's own key (BYOK), threaded to
    :func:`services.botmason.generate_response` exactly as the chat path does;
    ``None`` falls back to the server-side key.
    """
    if classification is JournalClassification.INTIMATE:
        raise IntimateContentRefusedError
    try:
        response = await generate_response(
            user_message=content[:MAX_FRAGMENT_CHARS],
            conversation_history=[],
            system_prompt=SYSTEM_PROMPT,
            api_key=api_key,
        )
    except LLMProviderError:
        logger.info("frequency_classification_degraded", extra={"reason": "provider_error"})
        return UNCLASSIFIED
    parsed = _parse_reply(response.text)
    if parsed is None:
        logger.info("frequency_classification_degraded", extra={"reason": "unparsable_reply"})
        return UNCLASSIFIED
    return parsed
