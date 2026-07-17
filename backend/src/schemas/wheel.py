"""Response schemas for the Wheel of Wholeness balance view."""

from __future__ import annotations

from pydantic import BaseModel, Field

from domain.constants import TOTAL_STAGES


class WheelAspect(BaseModel):
    """One Aspect's fullness at a stage, for the wheel layout."""

    stage_number: int
    aspect: str
    fullness: float


class WheelBalanceResponse(BaseModel):
    """The ten Aspect fullness values in canonical stage order.

    The Aspect list is capped at ``TOTAL_STAGES`` so a vault-supplied wheel read
    parsed through this schema cannot materialize an unbounded number of rows;
    an over-cap payload fails validation and the consumer degrades to the local
    balance. The local producer always emits exactly ``TOTAL_STAGES`` rows, so
    the cap never constrains the in-app path.
    """

    aspects: list[WheelAspect] = Field(max_length=TOTAL_STAGES)
