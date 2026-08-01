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

    Adepthood's own response shape for the wheel endpoint, never a parse of
    anything a vault sends: the seam's client owns creek's wire shape and hands
    the read path a domain value, which is relabelled and rendered through here
    like any locally-computed balance. The ``TOTAL_STAGES`` cap is therefore
    purely defensive -- the one producer that fills this model always emits
    exactly that many rows, and the cap is what keeps a future one from
    silently serializing more.
    """

    aspects: list[WheelAspect] = Field(max_length=TOTAL_STAGES)
