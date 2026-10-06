"""Every textual column in the schema is either ciphertext or plaintext *on purpose*.

``tests/test_journal_text_at_rest.py`` pins which columns are encrypted. That
guard is one-directional about everything else: a new column holding somebody's
writing, or a new column *derived* from it (an embedding, a tag set, a weight
map), ships in the clear and nothing notices. This module closes that gap. Every
String / Text / AutoString / Enum / JSON / ARRAY column must be either typed
``EncryptedString`` or named below under exactly one reason it is stored as
plaintext. An unclassified column fails, and so does a stale entry.

This is a classification, not a verdict. Several groups below hold material a
reader would call sensitive -- ``DERIVED_FROM_PROSE`` and ``USER_AUTHORED`` in
particular. They are named so the gap is visible and quotable, not because
plaintext is the right answer for them; whether to encrypt them or narrow what
the privacy copy claims is an owner decision (#3058 escalations AC5 / AC14).
"""

from __future__ import annotations

from collections import Counter

import pytest
from sqlalchemy import JSON, Column, Integer, MetaData, String, Table, Text, TypeDecorator
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.types import TypeEngine
from sqlmodel import SQLModel

from services.encryption_inventory import (
    EncryptedColumn,
    EncryptionInventoryError,
    encrypted_columns,
)
from services.journal_encryption import EncryptedString

# Each key is the reason its columns are stored as plaintext.
_PLAINTEXT_COLUMNS: dict[str, frozenset[str]] = {
    # Opaque machine identifiers, idempotency keys, digests and provider/model
    # names. None of these is anything a person wrote.
    "IDENTIFIER_OR_DIGEST": frozenset(
        {
            "authidentity.provider",
            "authidentity.subject",
            "coursestage.artifact_schema_version",
            "coursestage.source_path",
            "coursestage.source_repo",
            "coursestage.source_sha",
            "coursestage.source_sha256",
            "energyplan.idempotency_key",
            "entitlement.product_id",
            "feedbackreport.correlation_id",
            "feedbackreport.idem_key",
            "feedbackreport.public_id",
            "goalcompletionspend.idem_key",
            "gumroadsale.gumroad_sale_id",
            "gumroadsale.product_id",
            "journalentry.idem_key",
            "journalentry.vault_ref",
            "licensebinding.gumroad_sale_id",
            "licensebinding.product_id",
            "llmusagelog.generation_id",
            "llmusagelog.model",
            "llmusagelog.provider",
            "mettareturnofferdismissal.episode_key",
            "passwordresettoken.lookup_key",
            "passwordresettoken.token_hash",
            "practicesessionspend.idem_key",
            "practicesharelink.token",
            "promptresponse.idem_key",
            "revokedtoken.jti",
            "user.password_hash",
            "vaultactivation.activation_id",
            "vaultactivation.consumer_identity",
            "vaultactivation.creek_job_id",
            "vaultpipelinerun.job_id",
            "vaultpipelinerun.resume_claim_id",
            "vaultteardownreceipt.creek_job_id",
        }
    ),
    # Enum states and other closed vocabularies the code chooses from. Reading
    # one tells you which branch a row took, never what anybody said.
    "CLOSED_VOCABULARY": frozenset(
        {
            "accountdeletionaudit.vault_disposition",
            "completionsuggestion.status",
            "completionsuggestion.target_type",
            "corpusconsentevent.decision",
            "corpusconsentevent.source",
            "corpusfragment.source",
            "energyplan.reason_code",
            "entitlement.kind",
            "feedbackreport.app_build",
            "feedbackreport.category",
            "feedbackreport.control",
            "feedbackreport.impact",
            "feedbackreport.locale",
            "feedbackreport.platform",
            "feedbackreport.screen",
            "feedbackreport.status",
            "feedbackreport.viewport_class",
            "feedbacktriageevent.action",
            "feedbacktriageevent.new_state",
            "feedbacktriageevent.old_state",
            "goal.frequency_unit",
            "goal.origin",
            "goal.tier",
            "goalgroup.source",
            "gumroadsale.resource_name",
            "habit.notification_frequency",
            "habit.stage",
            "invitationsignal.kind",
            "invitationsignal.target_type",
            "journalentry.reflection_level",
            "journalentry.sender",
            "journalentry.status",
            "marginalia.kind",
            "marginalia.status",
            "practicesession.mode",
            "user.timezone",
            "vaultactivation.custody_mode",
            "vaultactivation.state",
            "vaultpipelinefollowup.trigger",
            "vaultpipelinerun.follow_up_trigger",
            "vaultpipelinerun.outcome",
            "vaultpipelinerun.stage",
            "vaultpipelinerun.trigger",
            "vaultteardownreceipt.state",
            "walletaudit.bucket",
            "walletaudit.reason",
        }
    ),
    # The course curriculum, shipped by the operator to every account alike.
    "OPERATOR_CURRICULUM": frozenset(
        {
            "coursestage.aspect",
            "coursestage.category",
            "coursestage.divine_gender_polarity",
            "coursestage.free_will_description",
            "coursestage.growing_up_stage",
            "coursestage.overview_url",
            "coursestage.relationship_to_free_will",
            "coursestage.spiral_dynamics_color",
            "coursestage.stage_key",
            "coursestage.subtitle",
            "coursestage.title",
            "promptresponse.question",
            "stagecontent.content_type",
            "stagecontent.title",
            "stagecontent.url",
        }
    ),
    # Practice catalogue rows. Seeded rows are operator content, but users can
    # submit practices and own recipes and tags, so some of these rows are a
    # person's own words stored in the clear.
    "CATALOGUE_OR_USER_DEFINED": frozenset(
        {
            "practice.description",
            "practice.instructions",
            "practice.mode",
            "practice.mode_config",
            "practice.name",
            "practicerecipe.description",
            "practicerecipe.mode",
            "practicerecipe.name",
            "practicerecipe.slug",
            "practicerecipestep.prompt_label",
            "practicerecipestep.tag_label",
            "practicerecipestep.tag_slug",
            "practicetag.label",
            "practicetag.slug",
        }
    ),
    # Account identity, contact and request provenance: personal data the auth,
    # billing and abuse paths must be able to query, and which the privacy copy
    # describes separately from writing.
    "ACCOUNT_IDENTITY": frozenset(
        {
            "authidentity.email_at_link_time",
            "entitlement.metadata",
            "gumroadsale.email",
            "gumroadsale.raw_payload",
            "loginattempt.email",
            "loginattempt.ip_address",
            "passwordresettoken.requested_ip",
            "passwordresettoken.requested_user_agent",
            "user.email",
            "uservaultconfig.vault_url",
        }
    ),
    # Operational records about the system's own behaviour.
    "OPERATIONAL_RECORD": frozenset(
        {
            "accountdeletionaudit.row_counts",
            "vaultactivation.failure_reason",
            "vaultteardownreceipt.failure_reason",
        }
    ),
    # Derived from a person's prose and stored in the clear. An embedding and a
    # frequency-weight map are computed *from* the encrypted text; vault tags
    # are frequency tags assigned to an entry on vault ingest; the privacy tier,
    # entry tag and reflection scope describe the entry. Each reveals something
    # about what was written without being it. Encrypting these versus
    # narrowing the "everything derived from it" copy is escalated (AC5/AC14).
    "DERIVED_FROM_PROSE": frozenset(
        {
            "corpusfragment.embedding",
            "corpusfragment.frequency_weights",
            "corpusfragment.tier",
            "journalentry.classification",
            "journalentry.reflection_scope_key",
            "journalentry.tag",
            "journalentry.vault_tags",
        }
    ),
    # Short labels a person typed -- a goal, a habit, a group, a renamed
    # practice, their display name. Their own words, stored in the clear, and
    # not in the encrypted inventory. Named so the privacy copy can be held to
    # it (B01), not because plaintext is settled policy for them.
    "USER_AUTHORED": frozenset(
        {
            "goal.description",
            "goal.target_unit",
            "goal.title",
            "goalgroup.description",
            "goalgroup.icon",
            "goalgroup.name",
            "habit.icon",
            "habit.name",
            "user.display_name",
            "userpractice.custom_name",
        }
    ),
    # Structured per-user state: schedules, plans, progress anchors, settings.
    # Personal, but numbers, dates and enum codes rather than sentences.
    "STRUCTURED_USER_STATE": frozenset(
        {
            "energyplan.plan_json",
            "goal.days_of_week",
            "habit.notification_days",
            "habit.notification_times",
            "practicesession.mode_metadata",
            "stageprogress.completed_stages",
            "stageprogress.past_cycle_anchors",
            "userpractice.mode_config_override",
        }
    ),
}

# Named by #3058 AC5: these must be classified as derived, by name, so a
# regrouping cannot quietly bury them among identifiers.
_PINNED_DERIVED = frozenset(
    {
        "corpusfragment.embedding",
        "corpusfragment.frequency_weights",
        "journalentry.vault_tags",
        "journalentry.classification",
        "journalentry.tag",
    }
)

# Types whose values can carry free text. ``JSON`` covers ``ARRAY`` too, because
# the SQLite suite swaps every ARRAY column to JSON in place (conftest).
_TEXTUAL_TYPES = (String, Text, JSON, ARRAY)


def _is_textual(column_type: TypeEngine[object]) -> bool:
    """Whether a column's type can hold text, looking through TypeDecorators.

    ``AutoString`` is a TypeDecorator over ``String``, not a subclass of it, so
    checking the declared type alone would silently skip most of the schema.
    """
    if isinstance(column_type, TypeDecorator):
        return isinstance(column_type.impl_instance, _TEXTUAL_TYPES)
    return isinstance(column_type, _TEXTUAL_TYPES)


def _schema_textual_columns() -> tuple[frozenset[str], frozenset[str]]:
    """(encrypted, plaintext-textual) ``table.column`` names in the live schema."""
    encrypted: set[str] = set()
    plaintext: set[str] = set()
    for table in SQLModel.metadata.tables.values():
        for column in table.columns:
            name = f"{table.name}.{column.name}"
            if isinstance(column.type, EncryptedString):
                encrypted.add(name)
            elif _is_textual(column.type):
                plaintext.add(name)
    return frozenset(encrypted), frozenset(plaintext)


def _classified() -> frozenset[str]:
    return frozenset().union(*_PLAINTEXT_COLUMNS.values())


def test_every_textual_column_is_classified() -> None:
    """A text-bearing column that is neither encrypted nor named here fails, by name."""
    _, plaintext = _schema_textual_columns()

    unclassified = sorted(plaintext - _classified())

    assert unclassified == [], (
        "plaintext textual columns with no stated reason; encrypt them "
        f"(EncryptedString) or classify them in this module: {unclassified}"
    )


def test_no_classification_is_stale_or_contradicts_the_schema() -> None:
    """Every entry names a live plaintext column -- never a missing or encrypted one."""
    encrypted, plaintext = _schema_textual_columns()

    assert sorted(_classified() & encrypted) == []
    assert sorted(_classified() - plaintext) == []


def test_no_column_is_classified_twice() -> None:
    """One reason per column, so the grouping is a partition and can be quoted."""
    counts = Counter(name for group in _PLAINTEXT_COLUMNS.values() for name in group)

    assert sorted(name for name, seen in counts.items() if seen > 1) == []


def test_columns_derived_from_prose_are_named_explicitly() -> None:
    """The derived columns #3058 names are classified as derived, not as identifiers."""
    assert _PLAINTEXT_COLUMNS["DERIVED_FROM_PROSE"] >= _PINNED_DERIVED


def test_the_inventory_module_agrees_with_the_schema() -> None:
    """``encrypted_columns`` is the schema's encrypted set, nothing more or less."""
    encrypted, _ = _schema_textual_columns()

    assert {c.qualified for c in encrypted_columns()} == encrypted
    assert list(encrypted_columns()) == sorted(encrypted_columns())


def test_the_inventory_refuses_a_table_its_cursor_cannot_page() -> None:
    """A composite or non-integer key would break the sweep's keyset paging."""
    metadata = MetaData()
    Table(
        "composite",
        metadata,
        Column("a", Integer, primary_key=True),
        Column("b", Integer, primary_key=True),
        Column("body", EncryptedString()),
    )

    with pytest.raises(EncryptionInventoryError, match="composite"):
        encrypted_columns(metadata)


def test_the_inventory_reads_a_supplied_schema() -> None:
    """A metadata argument is honoured, and its single-``id`` table is accepted."""
    metadata = MetaData()
    Table(
        "note",
        metadata,
        Column("id", Integer, primary_key=True),
        Column("body", EncryptedString()),
        Column("label", String),
    )

    assert encrypted_columns(metadata) == (EncryptedColumn("note", "body"),)
