"""LLM cost-metering write path — one ``LLMUsageLog`` row per real provider call.

The resonance and essay endpoints hand their adapter's accumulated responses to
:func:`record_llm_usage`, which stages one usage row per non-stub response inside
the caller's transaction.  Stub responses spend zero real tokens and are skipped
so the per-model dashboard stays clean and the pricing table never sees the stub
model.  The caller owns the commit, so metering shares the reflection's atomicity.

**Settlement lines (#623 PR3).** The ratified record
(``prompts/claude-comms/2026-09-05-resonance-economy-decision.md``) asks to
"instrument actual input/output tokens, model, cost estimate, refunds, and cache
hits" (§1) and to "meter real input/output tokens and corrective attempts" (§2).
:func:`log_generation_settled` emits one ``llm_generation_settled`` line per
settled generation with ids and counts only -- never a prompt, an entry, a note
or a letter. The numbers are in the message itself as well as in ``extra``,
because the production formatter (``observability._APP_LOG_FORMAT``) prints only
the message.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal
from enum import StrEnum
from typing import TYPE_CHECKING

from models.llm_usage_log import LLMUsageLog
from models.wallet_audit import (
    REASON_REFUND_DEMO,
    REASON_REFUND_FAILED_ESSAY,
    REASON_REFUND_FAILED_RESONANCE,
    REASON_REFUND_NO_ESSAY,
    REASON_REFUND_NO_NOTES,
)
from services.botmason import STUB_PROVIDER_NAME
from services.llm_pricing import estimate_cost_usd

if TYPE_CHECKING:
    from collections.abc import Sequence

    from sqlalchemy.ext.asyncio import AsyncSession

    from services.botmason import LLMResponse
    from services.wallet import SpendResult

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class GenerationKey:
    """Which generation a provider call belongs to, and whether the server paid.

    ``generation_id`` groups every call one generation made -- a resonance
    reflection, its corrective retry and the in-pass detection dial share one --
    so the admin metric can price "per charged generation" (record §2) rather
    than per call. ``charged`` is ``True`` exactly when a server-paid deduction
    committed for it, including generations later refunded as empty or refused:
    the provider cost was real either way. BYOK and uncharged calls are
    ``False``.
    """

    generation_id: str
    charged: bool

    @classmethod
    def for_spend(cls, spent: SpendResult | None) -> GenerationKey:
        """Key a new generation from its deduction (``None`` when BYOK paid)."""
        return cls(generation_id=uuid.uuid4().hex, charged=spent is not None)

    @classmethod
    def uncharged(cls) -> GenerationKey:
        """Key a new generation no wallet unit paid for."""
        return cls.for_spend(None)


class GenerationFeature(StrEnum):
    """The charged generation kinds a settlement line can name."""

    RESONANCE = "resonance"
    ESSAY = "essay"
    TRANSCRIPTION = "transcription"


class GenerationOutcome(StrEnum):
    """How a generation settled.

    ``kept`` -- the writer received it and any charge stands. ``refunded_empty``
    -- a pass that kept no notes. ``refunded_failed`` -- a generation that failed
    after its deduction committed (a provider error, a withdrawn entry, a care
    escalation, a failed write); a BYOK failure carries the same outcome with
    ``charged=False`` and no refund. ``refused`` -- an essay whose completion
    was not a letter. ``refunded_demo`` -- a generation the stub provider
    answered: a labelled demo, delivered and handed back (#3062).
    """

    KEPT = "kept"
    REFUNDED_EMPTY = "refunded_empty"
    REFUNDED_FAILED = "refunded_failed"
    REFUSED = "refused"
    REFUNDED_DEMO = "refunded_demo"


#: The outcome each generation refund reason settles as. Derived from the audit
#: reason so the log line and the ``walletaudit`` row can never disagree.
OUTCOME_FOR_REFUND_REASON: Mapping[str, GenerationOutcome] = {
    REASON_REFUND_NO_NOTES: GenerationOutcome.REFUNDED_EMPTY,
    REASON_REFUND_FAILED_RESONANCE: GenerationOutcome.REFUNDED_FAILED,
    REASON_REFUND_FAILED_ESSAY: GenerationOutcome.REFUNDED_FAILED,
    REASON_REFUND_NO_ESSAY: GenerationOutcome.REFUSED,
    REASON_REFUND_DEMO: GenerationOutcome.REFUNDED_DEMO,
}


@dataclass(frozen=True, slots=True)
class GenerationUsage:
    """One generation's real provider calls, summed.

    ``calls`` counts every non-stub call, so a resonance pass's in-pass
    detection dial makes it exceed ``attempts``. ``cost_usd`` is ``None`` when
    any call's model is unpriced -- an unknown cost is never summed as zero.
    ``model`` is the last real call's model, ``None`` when nothing was dialled.
    """

    calls: int
    prompt_tokens: int
    completion_tokens: int
    cost_usd: Decimal | None
    model: str | None


def _priced(responses: Sequence[LLMResponse]) -> list[tuple[LLMResponse, Decimal | None]]:
    """Pair each real (non-stub) response with its estimated cost."""
    return [
        (
            response,
            estimate_cost_usd(response.model, response.prompt_tokens, response.completion_tokens),
        )
        for response in responses
        if response.provider != STUB_PROVIDER_NAME
    ]


def _total_cost(costs: Sequence[Decimal | None]) -> Decimal | None:
    """Sum ``costs``, or ``None`` when any one is unknown (never summed as zero)."""
    if None in costs:
        return None
    return sum((cost for cost in costs if cost is not None), Decimal(0))


def _summarize(priced: Sequence[tuple[LLMResponse, Decimal | None]]) -> GenerationUsage:
    """Sum already-priced calls into one :class:`GenerationUsage`."""
    responses, costs = _split(priced)
    return GenerationUsage(
        calls=len(responses),
        prompt_tokens=sum(response.prompt_tokens for response in responses),
        completion_tokens=sum(response.completion_tokens for response in responses),
        cost_usd=_total_cost(costs),
        model=responses[-1].model if responses else None,
    )


def _split(
    priced: Sequence[tuple[LLMResponse, Decimal | None]],
) -> tuple[list[LLMResponse], list[Decimal | None]]:
    """Unzip priced calls into their responses and their costs."""
    return [response for response, _cost in priced], [cost for _response, cost in priced]


def summarize_usage(responses: Sequence[LLMResponse]) -> GenerationUsage:
    """Sum one generation's real calls: tokens, cost (``None`` if any unpriced), model."""
    return _summarize(_priced(responses))


@dataclass(frozen=True, slots=True)
class GenerationSettlement:
    """Everything one ``llm_generation_settled`` line reports.

    ``bucket`` is the wallet side that paid (``None`` when nobody was charged).
    ``attempts`` is the reflection's own attempt count -- 2 when the corrective
    retry ran -- 1 for an essay or a transcription, and 0 for a resonance pass
    that settled before reporting an outcome (it failed, or was withdrawn).
    """

    feature: GenerationFeature
    user_id: int
    key: GenerationKey
    bucket: str | None
    outcome: GenerationOutcome
    attempts: int
    usage: GenerationUsage


def log_generation_settled(settlement: GenerationSettlement) -> None:
    """Emit the one ``llm_generation_settled`` line for a settled generation.

    Ids and counts only. The cost is a fixed-point string (or ``None``), the
    same rendering the admin endpoints use, so a log reader and the dashboard
    see the same digits.
    """
    usage = settlement.usage
    cost = None if usage.cost_usd is None else format(usage.cost_usd, "f")
    logger.info(
        "llm_generation_settled feature=%s outcome=%s charged=%s attempts=%d calls=%d"
        " prompt_tokens=%d completion_tokens=%d cost_usd=%s",
        settlement.feature.value,
        settlement.outcome.value,
        settlement.key.charged,
        settlement.attempts,
        usage.calls,
        usage.prompt_tokens,
        usage.completion_tokens,
        cost,
        extra={
            "feature": settlement.feature.value,
            "outcome": settlement.outcome.value,
            "user_id": settlement.user_id,
            "generation_id": settlement.key.generation_id,
            "charged": settlement.key.charged,
            "bucket": settlement.bucket,
            "attempts": settlement.attempts,
            "calls": usage.calls,
            "prompt_tokens": usage.prompt_tokens,
            "completion_tokens": usage.completion_tokens,
            "cost_usd": cost,
            "model": usage.model,
        },
    )


async def record_llm_usage(
    session: AsyncSession,
    *,
    user_id: int,
    journal_entry_id: int | None,
    responses: Sequence[LLMResponse],
    generation: GenerationKey,
) -> GenerationUsage:
    """Stage an ``LLMUsageLog`` row for each real (non-stub) response.

    ``journal_entry_id`` is the entry the calls were about — the user's source
    entry on the resonance path, the annotated entry on the essay path — so the
    audit trail reconstructs each call's context with a single JOIN.  It is
    ``None`` for a stateless call with no associated entry (for example,
    single-page journal transcription), which still meters its cost.  Stub
    responses are skipped (zero real tokens, no pricing-table lookup).  No commit
    is issued here; the row shares the caller's transaction with the reflection.

    ``generation`` is required so no caller can meter a call without saying
    which generation it belongs to and whether the server paid: every row is
    stamped with both (#623 PR3). Returns the summed usage the caller's
    settlement line reports, priced once from the same estimates the rows hold.
    """
    priced = _priced(responses)
    for response, cost in priced:
        session.add(
            LLMUsageLog(
                user_id=user_id,
                journal_entry_id=journal_entry_id,
                provider=response.provider,
                model=response.model,
                prompt_tokens=response.prompt_tokens,
                completion_tokens=response.completion_tokens,
                total_tokens=response.total_tokens,
                estimated_cost_usd=cost,
                generation_id=generation.generation_id,
                charged=generation.charged,
            )
        )
    return _summarize(priced)
