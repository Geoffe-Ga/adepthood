"""Cross-system contract test for the practice-insight character cap.

The frontend's ``PRACTICE_INSIGHT_HARD_CAP`` constant (in
``frontend/src/features/Practice/components/InsightCaptureModal.tsx``)
must match the backend's ``PRACTICE_INSIGHT_MAX_LENGTH``. A drift here
silently changes the contract from "you can save up to N characters" on
one end to a different N on the other.

The previous safeguard was a "KEEP IN SYNC" comment on both sides — easy
to miss when bumping one. This test pins three things at once:

1. The Python constant equals the documented value (2000).
2. The Pydantic field's ``max_length`` equals the constant.
3. The FastAPI-generated OpenAPI schema's ``maxLength`` for the
   ``insight`` field of ``PracticeSessionCreate`` matches.

Any divergence here fires before merge. The frontend has a mirror test
(``frontend/src/features/Practice/components/__tests__/InsightCaptureModal.test.tsx``)
that pins ``PRACTICE_INSIGHT_HARD_CAP === 2_000`` — together the two
tests bracket the contract.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from pydantic import ValidationError

from main import app
from schemas.practice import PRACTICE_INSIGHT_MAX_LENGTH, PracticeSessionCreate

# The expected wire value. If this ever changes, BOTH constants (here and
# the frontend mirror) must update — the change ripples through the
# OpenAPI schema and the frontend test, surfacing the contract drift.
_EXPECTED_INSIGHT_CAP = 2_000


def test_python_constant_matches_expected_wire_value() -> None:
    """Pins the source-of-truth constant. Frontend mirror reads the same value."""
    assert PRACTICE_INSIGHT_MAX_LENGTH == _EXPECTED_INSIGHT_CAP


def test_pydantic_field_max_length_matches_constant() -> None:
    """The Pydantic field's ``max_length`` must derive from the constant.

    Without this, a developer who bumps the constant but leaves a hardcoded
    ``max_length=2000`` on the field would have the OpenAPI schema drift
    out of sync with the constant.
    """
    field = PracticeSessionCreate.model_fields["insight"]
    # Pydantic stores ``max_length`` as a constraint on the field's metadata.
    constraints = [m for m in field.metadata if getattr(m, "max_length", None) is not None]
    assert constraints, "PracticeSessionCreate.insight has no max_length constraint"
    assert all(c.max_length == PRACTICE_INSIGHT_MAX_LENGTH for c in constraints)


def test_openapi_schema_exposes_the_insight_cap() -> None:
    """FastAPI's auto-generated OpenAPI schema reflects the same maxLength.

    The frontend (which currently hardcodes ``PRACTICE_INSIGHT_HARD_CAP``)
    can in principle derive its cap from this OpenAPI field by reading the
    spec at build time — this test pins the schema shape that pipeline
    would depend on, so the contract is enforced even before that work
    lands.
    """
    schema = app.openapi()
    create_schema = schema["components"]["schemas"]["PracticeSessionCreate"]
    insight = create_schema["properties"]["insight"]
    # ``insight`` is ``str | None`` — the maxLength sits inside one of the
    # ``anyOf`` branches (the string branch); FastAPI may also hoist it to
    # the top level depending on the Pydantic version. Accept either shape.
    found_max = _extract_max_length(insight)
    assert found_max == PRACTICE_INSIGHT_MAX_LENGTH, (
        f"OpenAPI maxLength for insight is {found_max}; expected "
        f"{PRACTICE_INSIGHT_MAX_LENGTH}. The frontend "
        "``PRACTICE_INSIGHT_HARD_CAP`` mirror also needs to move."
    )


def _extract_max_length(field_schema: dict[str, object]) -> int | None:
    """Pluck the ``maxLength`` from a possibly-nullable string schema."""
    direct = field_schema.get("maxLength")
    if isinstance(direct, int):
        return direct
    any_of = field_schema.get("anyOf")
    if isinstance(any_of, list):
        for branch in any_of:
            if isinstance(branch, dict):
                branch_max = branch.get("maxLength")
                if isinstance(branch_max, int):
                    return branch_max
    return None


@pytest.mark.parametrize("invalid_length", [_EXPECTED_INSIGHT_CAP + 1, _EXPECTED_INSIGHT_CAP * 10])
def test_pydantic_rejects_insight_exceeding_cap(invalid_length: int) -> None:
    """End-to-end pin: a too-long insight is rejected by the model at all sizes past cap."""
    started = datetime.now(UTC)
    with pytest.raises(ValidationError) as exc:
        PracticeSessionCreate(
            user_practice_id=1,
            started_at=started,
            ended_at=started + timedelta(minutes=5),
            insight="x" * invalid_length,
        )
    assert "at most" in str(exc.value) or "max_length" in str(exc.value).lower()
