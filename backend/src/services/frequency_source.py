"""One authority per fragment: the Creek Vault wins, the operator side is the floor.

Two things in this codebase can answer "what frequency is this writing" --
:meth:`~domain.creek_vault.CreekVaultClient.classify`, run by the user's own
vault over their own corpus, and
:func:`services.frequency_classification.classify_frequencies`, run by the
operator against a cloud provider. Until this module existed there was no rule
saying which of them wins and no record saying which of them produced a given
answer, and the two are indistinguishable after the fact: both are weights over
the same ten codes.

**The vault wins.** It is the user's own instrument over their own corpus, the
operator-side path is explicitly the floor rather than a replacement, and
:func:`services.creek_vault_wheel.select_wheel_balance` already resolves the
same question the same way for the wheel -- so the two read paths do not
disagree about who is authoritative. When the vault answers, the operator-side
classifier is not called at all: not called and outvoted, not called and
averaged, not called. A second opinion nobody asked for still costs the user a
provider call and still ships their writing to a cloud they were running a vault
specifically to avoid.

**Every failure degrades in silence, and none of them is ever a failed write.**
An absent, unavailable, capability-poor, refusing or unreadable vault falls back
to the operator-side classifier exactly as ``_read_balance`` falls back to the
local balance, and the degrade is recorded through
:func:`services.creek_vault_read.log_read_degraded` -- the same closed-vocabulary
record the wheel path writes, because a read that is invisible to the user is
one only a log can count. The single exception is
:class:`~services.frequency_classification.IntimateContentRefusedError`, which is
raised before *either* path is entered: it means a caller routed the most
sensitive tier at a classifier, which is a defect at the call site rather than a
runtime condition to degrade around.

**The join is on the code.** A vault tag is one of ``F1``..``F10``, the wire form
:mod:`domain.frequencies` publishes, and a tag outside that set rejects the whole
answer rather than being dropped from it -- ``_parse_weights``' rule, for
``_parse_weights``' reason. Nothing here resolves a tag by *name* or by
*colour-word*: the two labelings of these ten positions agree on six and diverge
on the middle four, so a name join would look correct and be wrong for exactly
those four.

The vault branch is unreachable in this deployment today --
:meth:`services.creek_vault_client.HttpCreekVaultClient.classify` refuses
outright while Creek's ``/v1`` classify shape is unratified upstream -- so the
rule degrades to the operator-side classifier on every call. That is the correct
steady state, and it is why the rule is written now rather than after rows
exist: provenance added later is a backfill nobody can answer.

Storing the provenance is a separate step this module does not take.
``CorpusFragment`` carries no column for it yet, and the classification a
fragment was written from currently reaches the row as weights alone.
"""

from __future__ import annotations

from types import MappingProxyType
from typing import Final

from domain.creek_vault import (
    CreekCapability,
    CreekVaultClient,
    CreekVaultError,
    CreekVaultPayloadError,
    VaultTierCeiling,
    tier_ceiling_for,
)
from domain.frequencies import FREQUENCY_CODES, Frequency
from models.journal_entry import JournalClassification
from services.creek_vault_read import log_read_degraded
from services.frequency_classification import (
    ClassificationSource,
    FrequencyClassification,
    IntimateContentRefusedError,
    classify_frequencies,
)

#: What one vault tag is worth. Creek's classify answer is a *set of positions*,
#: not a distribution: it names the frequencies it found and says nothing about
#: how strongly, so every tag it returns is a flat assertion. One is the honest
#: projection of "asserted" onto the weights the operator side produces by
#: degree. If the ratified ``/v1`` shape later carries per-tag weights, this
#: constant and :func:`_vault_weights` are the only things that change.
VAULT_TAG_WEIGHT: Final[float] = 1.0

#: How sure a vault answer is taken to be. The vault classified the user's own
#: corpus with the user's own instrument and returned tags rather than hedges;
#: inventing a discount here would be adepthood second-guessing the authority it
#: just declared.
VAULT_TAG_CONFIDENCE: Final[float] = 1.0

# What an unreadable tag set is reported as. Static and capability-named like
# every message in the seam's hierarchy: the rejected tag is a string the vault
# chose, and a message that quoted it would put vault-supplied text into a log
# record whose whole point is that it holds none.
_UNREADABLE_TAGS_MESSAGE = "creek vault answered outside the ontology: creek.classify"


def _vault_weights(tags: tuple[str, ...]) -> MappingProxyType[Frequency, float] | None:
    """Project vault tags onto weights, or ``None`` if any tag is outside the ontology.

    All-or-nothing, mirroring :func:`services.frequency_classification._parse_weights`
    and for the same reason: a tag naming ``F11`` means this side and the vault
    disagree about how many positions there are, and keeping the tags either side
    of it would let that disagreement pass as a slightly smaller answer. Repeated
    tags collapse, since a tag names a position rather than counting one.
    """
    if any(tag not in FREQUENCY_CODES for tag in tags):
        return None
    return MappingProxyType({Frequency(tag): VAULT_TAG_WEIGHT for tag in tags})


async def _read_classification(
    client: CreekVaultClient, body: str, ceiling: VaultTierCeiling
) -> FrequencyClassification | None:
    """Call the vault's classify, mapping every way it can fail to ``None``.

    :class:`~domain.creek_vault.CreekVaultError` covers all of them -- the
    adapter normalizes a refusal, a rejected credential, an unreachable vault and
    an unadvertised capability into that one hierarchy -- and an answer whose
    tags will not project is reported as a payload fault, because that is exactly
    what it is: a reachable vault that answered successfully in a vocabulary
    adepthood cannot read, which is a bug worth reporting upstream rather than
    infrastructure worth restoring.

    An empty tag tuple returns ``None`` without a log line. It is the absence of
    an answer rather than an answer of absence:
    :class:`~domain.creek_vault.VaultIngestResult` says so outright of the same
    field -- a vault that does not return tags yields an empty tuple -- so a
    vault that has failed at nothing is not recorded as having degraded, and the
    fragment gets the operator-side reading instead of being dropped from the
    corpus for carrying no position at all.
    """
    try:
        answer = await client.classify(body, ceiling)
    except CreekVaultError as error:
        log_read_degraded(CreekCapability.CLASSIFY, error)
        return None
    weights = _vault_weights(answer.tags)
    if weights is None:
        log_read_degraded(
            CreekCapability.CLASSIFY, CreekVaultPayloadError(_UNREADABLE_TAGS_MESSAGE)
        )
        return None
    if not weights:
        return None
    return FrequencyClassification(
        weights=weights,
        overall_confidence=VAULT_TAG_CONFIDENCE,
        source=ClassificationSource.VAULT,
    )


async def fetch_vault_classification(
    client: CreekVaultClient, content: str, *, classification: JournalClassification
) -> FrequencyClassification | None:
    """Return the vault's reading of ``content``, or ``None`` to fall back.

    The gate order is the read path's own: a handshake first, then an unavailable
    vault or one that never advertised ``creek.classify`` degrades *before* the
    call is made rather than by catching the error it would have raised.

    ``content`` goes to the vault whole, unlike the operator-side path, which
    truncates at ``MAX_FRAGMENT_CHARS``. That ceiling is a cost ceiling on a
    metered cloud provider; a vault is the user's own instrument over their own
    corpus and bills them nothing, so trimming a long entry before showing it to
    the authority would cost accuracy to save a cost that is not there.

    The tier ceiling is the fragment's own, resolved through
    :func:`~domain.creek_vault.tier_ceiling_for`, so a public entry travels at
    ``OPEN`` and a personal one at ``PERSONAL`` rather than everything sharing
    one fixed ceiling. INTIMATE never reaches here at all.
    """
    await client.handshake()
    if not (client.is_available() and client.supports(CreekCapability.CLASSIFY)):
        return None
    return await _read_classification(client, content, tier_ceiling_for(classification.value))


async def select_frequency_classification(
    client: CreekVaultClient,
    content: str,
    *,
    classification: JournalClassification,
    api_key: str | None = None,
) -> FrequencyClassification:
    """Return the vault's classification of ``content``, else the operator-side one.

    The precedence rule, and the only place it is written: one source per
    fragment, never a hybrid, the answer stamped with whichever side produced it.

    Raises :class:`~services.frequency_classification.IntimateContentRefusedError`
    for INTIMATE content, before the handshake and before the operator-side call
    -- the refusal precedes both paths rather than sitting inside one of them.

    A spent balance on the operator-side call propagates as
    :class:`services.botmason.LLMCreditExhaustedError` rather than degrading,
    because it is a fact about the key rather than about this content and a
    caller working through a batch has to be able to stop. It reaches here only
    from the operator side: a vault that answers is preferred outright and is
    reached with the deployment's own vault credential, which has no balance to
    spend. Whichever key it was -- and unlike the corpus path this one does
    thread the caller's own -- is what decides whether the remedy is theirs or
    an operator's; see :func:`services.botmason.credit_exhausted_error`.

    ``api_key`` is the caller's own key (BYOK) and is threaded to the
    operator-side classifier only; a vault is reached with the deployment's own
    vault credential and has no use for it.
    """
    if classification is JournalClassification.INTIMATE:
        raise IntimateContentRefusedError
    from_vault = await fetch_vault_classification(client, content, classification=classification)
    if from_vault is not None:
        return from_vault
    return await classify_frequencies(content, classification=classification, api_key=api_key)
