"""Schema-layer tests for StageProgressRecord.cycle_number.

Covers:
- StageProgressRecord exposes cycle_number with default 1.
- Constructing StageProgressRecord with cycle_number=0 raises ValidationError (ge=1).
- Constructing StageProgressRecord with a negative cycle_number raises ValidationError.
- cycle_number is serialised in model_dump output.
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from schemas.stage import StageProgressRecord


class TestStageProgressRecordCycleNumber:
    """StageProgressRecord cycle_number field behaviours."""

    def test_cycle_number_field_present(self) -> None:
        """StageProgressRecord model_fields must include 'cycle_number'."""
        assert "cycle_number" in StageProgressRecord.model_fields

    def test_cycle_number_defaults_to_one(self) -> None:
        """Omitting cycle_number produces a record with cycle_number == 1."""
        record = StageProgressRecord(
            id=1,
            user_id=42,
            current_stage=1,
            completed_stages=[],
        )
        assert record.cycle_number == 1

    def test_cycle_number_zero_raises_validation_error(self) -> None:
        """cycle_number=0 must be rejected (ge=1 constraint)."""
        with pytest.raises(ValidationError):
            StageProgressRecord(
                id=1,
                user_id=42,
                current_stage=1,
                completed_stages=[],
                cycle_number=0,
            )

    def test_cycle_number_negative_raises_validation_error(self) -> None:
        """Negative cycle_number must be rejected (ge=1 constraint)."""
        with pytest.raises(ValidationError):
            StageProgressRecord(
                id=1,
                user_id=42,
                current_stage=1,
                completed_stages=[],
                cycle_number=-5,
            )

    def test_cycle_number_one_is_valid(self) -> None:
        """cycle_number=1 (the minimum) must be accepted."""
        record = StageProgressRecord(
            id=1,
            user_id=42,
            current_stage=1,
            completed_stages=[],
            cycle_number=1,
        )
        assert record.cycle_number == 1

    def test_cycle_number_serialised_in_model_dump(self) -> None:
        """model_dump must include cycle_number so the JSON response carries it."""
        record = StageProgressRecord(
            id=7,
            user_id=3,
            current_stage=2,
            completed_stages=[1],
        )
        dumped = record.model_dump()
        assert "cycle_number" in dumped
        assert dumped["cycle_number"] == 1
