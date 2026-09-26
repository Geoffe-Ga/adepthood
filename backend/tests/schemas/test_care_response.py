"""Tests for the :class:`schemas.marginalia.CareResponse` wire contract.

The care surface's heading is required and never blank (#2862): the client
renders it as the card's header-role element, so an empty title would leave a
screen reader announcing nothing where the note begins.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from schemas.marginalia import CareResponse


def test_care_response_requires_a_title() -> None:
    with pytest.raises(ValidationError, match="title"):
        CareResponse.model_validate({"message": "m", "resources": []})


def test_care_response_rejects_a_blank_title() -> None:
    with pytest.raises(ValidationError, match="title"):
        CareResponse(title="", message="m", resources=[])


def test_care_response_carries_the_title() -> None:
    assert CareResponse(title="t", message="m", resources=[]).title == "t"
