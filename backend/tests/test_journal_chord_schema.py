"""Schema-layer tests for chord journaling (primary_aspect / secondary_aspect).

Covers:
- JournalMessageCreate: omitted -> both None; round-trip; chord-shape and
  range violations raise ValidationError.
- JournalEntryUpdate: aspect-only PATCH satisfies the at-least-one guard;
  explicit-null aspects are accepted (model_fields_set); empty {} still
  raises; chord-shape validator applies.
- JournalMessageResponse: both fields present and serialised.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from schemas.journal import JournalEntryUpdate, JournalMessageCreate, JournalMessageResponse


class TestJournalMessageCreateChord:
    """JournalMessageCreate primary_aspect / secondary_aspect behaviours."""

    def test_omitted_aspects_default_to_none(self) -> None:
        """A payload that omits both aspects should leave them None."""
        schema = JournalMessageCreate(message="Hello world.")
        assert schema.primary_aspect is None
        assert schema.secondary_aspect is None

    def test_primary_only_round_trips(self) -> None:
        """A primary_aspect alone (no secondary) survives the parse cycle."""
        schema = JournalMessageCreate(message="A thought.", primary_aspect=3)
        assert schema.primary_aspect == 3
        assert schema.secondary_aspect is None

    def test_primary_and_secondary_round_trip(self) -> None:
        """A full chord survives the parse cycle."""
        schema = JournalMessageCreate(message="A thought.", primary_aspect=3, secondary_aspect=7)
        assert schema.primary_aspect == 3
        assert schema.secondary_aspect == 7

    def test_secondary_without_primary_raises_validation_error(self) -> None:
        """A secondary with no primary violates the chord-shape rule."""
        with pytest.raises(ValidationError):
            JournalMessageCreate(message="Oops.", secondary_aspect=7)

    def test_secondary_equal_to_primary_raises_validation_error(self) -> None:
        """secondary_aspect == primary_aspect violates the chord-shape rule."""
        with pytest.raises(ValidationError):
            JournalMessageCreate(message="Oops.", primary_aspect=4, secondary_aspect=4)

    def test_primary_zero_raises_validation_error(self) -> None:
        """primary_aspect=0 is below the 1..10 range."""
        with pytest.raises(ValidationError):
            JournalMessageCreate(message="Oops.", primary_aspect=0)

    def test_primary_eleven_raises_validation_error(self) -> None:
        """primary_aspect=11 is above the 1..10 range."""
        with pytest.raises(ValidationError):
            JournalMessageCreate(message="Oops.", primary_aspect=11)

    def test_secondary_zero_raises_validation_error(self) -> None:
        """secondary_aspect=0 is below the 1..10 range."""
        with pytest.raises(ValidationError):
            JournalMessageCreate(message="Oops.", primary_aspect=5, secondary_aspect=0)

    def test_secondary_eleven_raises_validation_error(self) -> None:
        """secondary_aspect=11 is above the 1..10 range."""
        with pytest.raises(ValidationError):
            JournalMessageCreate(message="Oops.", primary_aspect=5, secondary_aspect=11)


class TestJournalEntryUpdateChord:
    """JournalEntryUpdate primary_aspect / secondary_aspect behaviours."""

    def test_aspect_only_satisfies_at_least_one_validator(self) -> None:
        """Providing only primary_aspect should pass the at-least-one guard."""
        schema = JournalEntryUpdate(primary_aspect=3)
        assert schema.primary_aspect == 3
        assert schema.message is None
        assert schema.title is None
        assert schema.status is None

    def test_empty_payload_still_raises(self) -> None:
        """An empty PATCH payload must still be rejected (the pre-existing guard)."""
        with pytest.raises(ValidationError, match="at least one field"):
            JournalEntryUpdate()

    def test_explicit_null_aspects_are_accepted(self) -> None:
        """PATCH {'primary_aspect': null, 'secondary_aspect': null} must be accepted.

        An explicit null still counts as "a field was provided" via
        model_fields_set, so this must NOT raise the at-least-one guard.
        """
        schema = JournalEntryUpdate.model_validate(
            {"primary_aspect": None, "secondary_aspect": None}
        )
        assert schema.primary_aspect is None
        assert schema.secondary_aspect is None
        assert "primary_aspect" in schema.model_fields_set
        assert "secondary_aspect" in schema.model_fields_set

    def test_chord_shape_applies_to_update(self) -> None:
        """Secondary without primary in a PATCH violates the chord-shape rule."""
        with pytest.raises(ValidationError):
            JournalEntryUpdate(secondary_aspect=7)

    def test_secondary_equal_to_primary_raises_in_update(self) -> None:
        """secondary_aspect == primary_aspect violates the chord-shape rule in a PATCH."""
        with pytest.raises(ValidationError):
            JournalEntryUpdate(primary_aspect=6, secondary_aspect=6)

    def test_aspects_with_other_fields_is_valid(self) -> None:
        """Chord fields can be combined with other fields without error."""
        schema = JournalEntryUpdate(primary_aspect=2, secondary_aspect=8, title="A Title")
        assert schema.primary_aspect == 2
        assert schema.secondary_aspect == 8
        assert schema.title == "A Title"


class TestJournalMessageResponseChord:
    """JournalMessageResponse must expose both chord fields."""

    def test_response_includes_chord_fields(self) -> None:
        """JournalMessageResponse model_fields must include both aspect fields."""
        assert "primary_aspect" in JournalMessageResponse.model_fields
        assert "secondary_aspect" in JournalMessageResponse.model_fields

    def test_response_serialises_chord_fields(self) -> None:
        """A JournalMessageResponse built from attributes exposes both aspect fields."""
        now = datetime.now(UTC)
        resp = JournalMessageResponse(
            id=1,
            title=None,
            message="Hello.",
            status="draft",
            sender="user",
            timestamp=now,
            updated_at=now,
            tag="freeform",
            practice_session_id=None,
            user_practice_id=None,
            classification="personal",
            primary_aspect=3,
            secondary_aspect=7,
        )
        assert resp.primary_aspect == 3
        assert resp.secondary_aspect == 7
        dumped = resp.model_dump()
        assert dumped["primary_aspect"] == 3
        assert dumped["secondary_aspect"] == 7

    def test_response_serialises_none_chord_fields(self) -> None:
        """A JournalMessageResponse without a chord exposes both fields as None."""
        now = datetime.now(UTC)
        resp = JournalMessageResponse(
            id=1,
            title=None,
            message="Hello.",
            status="draft",
            sender="user",
            timestamp=now,
            updated_at=now,
            tag="freeform",
            practice_session_id=None,
            user_practice_id=None,
            classification="personal",
            primary_aspect=None,
            secondary_aspect=None,
        )
        dumped = resp.model_dump()
        assert dumped["primary_aspect"] is None
        assert dumped["secondary_aspect"] is None
