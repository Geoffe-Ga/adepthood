"""Schema-layer tests for the JournalClassification tier (issue #894).

Covers:
- JournalMessageCreate: omitted classification → default personal.
- JournalMessageCreate: explicit valid value round-trips.
- JournalMessageCreate: invalid value raises ValidationError.
- JournalEntryUpdate: classification alone satisfies the at-least-one validator.
- JournalEntryUpdate: empty {} still raises (the existing at-least-one guard).
- JournalMessageResponse: classification field is present and serialised.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from models.journal_entry import JournalClassification
from schemas.journal import JournalEntryUpdate, JournalMessageCreate, JournalMessageResponse


class TestJournalMessageCreateClassification:
    """JournalMessageCreate classification field behaviours."""

    def test_omitted_classification_defaults_to_personal(self) -> None:
        """A payload that omits classification should default to 'personal'."""
        schema = JournalMessageCreate(message="Hello world.")
        assert schema.classification == JournalClassification.PERSONAL
        assert schema.classification.value == "personal"

    def test_explicit_intimate_round_trips(self) -> None:
        """An explicit 'intimate' value survives the parse/serialize cycle."""
        schema = JournalMessageCreate(message="Private thought.", classification="intimate")
        assert schema.classification == JournalClassification.INTIMATE

    def test_explicit_public_round_trips(self) -> None:
        """An explicit 'public' value survives the parse/serialize cycle."""
        schema = JournalMessageCreate(message="Public thought.", classification="public")
        assert schema.classification == JournalClassification.PUBLIC

    def test_invalid_classification_raises_validation_error(self) -> None:
        """A value not in the enum raises ValidationError (not a raw Python error)."""
        with pytest.raises(ValidationError):
            JournalMessageCreate(message="Oops.", classification="secret")


class TestJournalEntryUpdateClassification:
    """JournalEntryUpdate classification field behaviours."""

    def test_classification_alone_satisfies_at_least_one_validator(self) -> None:
        """Providing only classification should pass the at-least-one guard."""
        schema = JournalEntryUpdate(classification="intimate")
        assert schema.classification == JournalClassification.INTIMATE
        # Confirm the other fields stayed None (not accidentally populated).
        assert schema.message is None
        assert schema.title is None
        assert schema.status is None

    def test_empty_payload_still_raises(self) -> None:
        """An empty PATCH payload must still be rejected (the pre-existing guard)."""
        with pytest.raises(ValidationError, match="at least one field"):
            JournalEntryUpdate()

    def test_classification_with_other_fields_is_valid(self) -> None:
        """Classification can be combined with other fields without error."""
        schema = JournalEntryUpdate(classification="public", title="A Title")
        assert schema.classification == JournalClassification.PUBLIC
        assert schema.title == "A Title"


class TestJournalMessageResponseClassification:
    """JournalMessageResponse must expose classification."""

    def test_response_includes_classification_field(self) -> None:
        """JournalMessageResponse model_fields must include 'classification'."""
        assert "classification" in JournalMessageResponse.model_fields

    def test_response_serialises_classification(self) -> None:
        """A JournalMessageResponse built from attributes exposes classification as a string."""
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
            classification="intimate",
        )
        assert resp.classification.value == "intimate"
        dumped = resp.model_dump()
        assert dumped["classification"] == "intimate"
