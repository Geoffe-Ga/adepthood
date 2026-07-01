"""Response schemas for the Wheel of Wholeness balance view."""

from __future__ import annotations

from pydantic import BaseModel


class WheelAspect(BaseModel):
    """One Aspect's fullness at a stage, for the wheel layout."""

    stage_number: int
    aspect: str
    fullness: float


class WheelBalanceResponse(BaseModel):
    """The ten Aspect fullness values in canonical stage order."""

    aspects: list[WheelAspect]
