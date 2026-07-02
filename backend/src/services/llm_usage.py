"""LLM cost-metering write path — one ``LLMUsageLog`` row per real provider call.

The resonance and essay endpoints hand their adapter's accumulated responses to
:func:`record_llm_usage`, which stages one usage row per non-stub response inside
the caller's transaction.  Stub responses spend zero real tokens and are skipped
so the per-model dashboard stays clean and the pricing table never sees the stub
model.  The caller owns the commit, so metering shares the reflection's atomicity.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from models.llm_usage_log import LLMUsageLog
from services.botmason import STUB_PROVIDER_NAME
from services.llm_pricing import estimate_cost_usd

if TYPE_CHECKING:
    from collections.abc import Sequence

    from sqlalchemy.ext.asyncio import AsyncSession

    from services.botmason import LLMResponse


async def record_llm_usage(
    session: AsyncSession,
    *,
    user_id: int,
    journal_entry_id: int,
    responses: Sequence[LLMResponse],
) -> None:
    """Stage an ``LLMUsageLog`` row for each real (non-stub) response.

    ``journal_entry_id`` is the entry the calls were about — the user's source
    entry on the resonance path, the annotated entry on the essay path — so the
    audit trail reconstructs each call's context with a single JOIN.  Stub
    responses are skipped (zero real tokens, no pricing-table lookup).  No commit
    is issued here; the row shares the caller's transaction with the reflection.
    """
    for response in responses:
        if response.provider == STUB_PROVIDER_NAME:
            continue
        session.add(
            LLMUsageLog(
                user_id=user_id,
                journal_entry_id=journal_entry_id,
                provider=response.provider,
                model=response.model,
                prompt_tokens=response.prompt_tokens,
                completion_tokens=response.completion_tokens,
                total_tokens=response.total_tokens,
                estimated_cost_usd=estimate_cost_usd(
                    response.model, response.prompt_tokens, response.completion_tokens
                ),
            )
        )
