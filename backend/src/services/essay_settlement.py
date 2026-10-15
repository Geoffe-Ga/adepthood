"""How a kept letter is settled: its charge, its one settlement line, and its cache write.

Shared by both letter sources the essay route has -- the app provider and, for a
vault-bound writer, the vault itself (#3203) -- so a letter from either is
cached, stamped and billed under one rule (#623, #3062).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from models.marginalia import Marginalia
from models.wallet_audit import REASON_REFUND_DEMO
from services.inference_provenance import is_demo, stamp_letter
from services.llm_usage import (
    GenerationFeature,
    GenerationKey,
    GenerationOutcome,
    GenerationSettlement,
    GenerationUsage,
    log_generation_settled,
)
from services.marginalia import InferenceReceipt
from services.wallet import SpendResult, log_committed_refund, refund_one_message

# An essay is one dial: ``generate_essay`` has no corrective retry.
ESSAY_ATTEMPTS = 1


@dataclass(frozen=True, slots=True)
class EssayCharge:
    """A first letter's deduction (``None`` when nobody paid) and its generation."""

    spent: SpendResult | None
    key: GenerationKey


def log_settled_essay(
    note: Marginalia, charge: EssayCharge, usage: GenerationUsage, outcome: GenerationOutcome
) -> None:
    """Write a committed essay's one settlement line (#623 PR3)."""
    log_generation_settled(
        GenerationSettlement(
            feature=GenerationFeature.ESSAY,
            user_id=note.user_id,
            key=charge.key,
            bucket=None if charge.spent is None else charge.spent.bucket,
            outcome=outcome,
            attempts=ESSAY_ATTEMPTS,
            usage=usage,
        )
    )


async def keep_letter(
    session: AsyncSession,
    note: Marginalia,
    essay: str,
    receipt: InferenceReceipt | None,
    charge: EssayCharge,
) -> GenerationOutcome:
    """Cache the letter with its source; hand a demo letter's unit back in the same commit.

    The letter's source is stamped beside the letter itself, so the two can
    never be committed apart. A stub letter is still cached -- the writer asked
    for it and sees it labelled as a demo -- but it is never billed (#3062).
    Returns the outcome the settlement line reports.
    """
    note.essay = essay
    note.essay_generated_at = datetime.now(UTC)
    stamp_letter(note, receipt)
    demo = is_demo(receipt)
    refund = None
    if demo and charge.spent is not None:
        refund = await refund_one_message(
            session, note.user_id, charge.spent, reason=REASON_REFUND_DEMO
        )
    await session.commit()
    log_committed_refund(refund)
    return GenerationOutcome.REFUNDED_DEMO if demo else GenerationOutcome.KEPT
