"""``EncryptedJSONList``: a list column stored as ``EncryptedString`` ciphertext (#3263).

``corpusfragment.embedding`` and ``journalentry.vault_tags`` are derived from a
person's writing. They used to sit in the clear beside the encrypted text they
came from. Each is now JSON-serialised and then run through the same
``EncryptedString`` codec as the writing, so the stored bytes are a marked
Fernet token. The model still reads and writes a plain ``list``, and NULL is
still NULL.
"""

from __future__ import annotations

import json
import string
from collections.abc import Iterator

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import Column, Integer, MetaData, String, Table, Text, text
from sqlalchemy.dialects import sqlite
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import SQLModel

from models.corpus_fragment import CorpusFragment
from models.journal_entry import JournalEntry
from models.user import User
from services import journal_encryption as je

_MARKER = "enc::v1::"
_FERNET_ALPHABET = frozenset(string.ascii_letters + string.digits + "-_=")
_TAGS = ["F5", "phase:withdrawal"]
_EMBEDDING = [0.125, -0.5, 3.0e-7, 1.0]


@pytest.fixture
def _keyed(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """A throwaway key, with the process-cached registry reset on both sides."""
    monkeypatch.setenv(je.KEYS_ENV_VAR, Fernet.generate_key().decode())
    je.reset_cache()
    yield
    je.reset_cache()


@pytest.fixture
def _unkeyed(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """No key and no production signal: the codec is an explicit passthrough."""
    for name in (je.KEYS_ENV_VAR, *je.PRODUCTION_SIGNAL_ENV_VARS):
        monkeypatch.delenv(name, raising=False)
    je.reset_cache()
    yield
    je.reset_cache()


def _bind(value: je.JSONList | None) -> object:
    """What the full bind chain (list -> JSON -> ciphertext) hands the driver."""
    processor = je.EncryptedJSONList().bind_processor(sqlite.dialect())
    assert processor is not None
    return processor(value)


def _result(stored: str | None) -> object:
    """What the full result chain (ciphertext -> JSON -> list) hands the model."""
    processor = je.EncryptedJSONList().result_processor(sqlite.dialect(), None)
    assert processor is not None
    return processor(stored)


async def _user_id(session: AsyncSession) -> int:
    user = User(email="lists@example.com", password_hash="x")  # pragma: allowlist secret
    session.add(user)
    await session.flush()
    assert user.id is not None
    return user.id


def _assert_ciphertext_of(stored: str, plaintext_list: list[object]) -> None:
    """The raw value is marked ciphertext, not the JSON, and decrypts to the list."""
    assert stored.startswith(_MARKER)
    assert json.dumps(plaintext_list) not in stored
    # Every byte after the marker is Fernet's base64url, so no JSON bracket, quote,
    # comma, colon or decimal point of the plaintext survives. A per-element
    # substring check would be wrong: a short tag like "F5" is itself base64url
    # and occurs in random ciphertext by chance.
    assert set(stored.removeprefix(_MARKER)) <= _FERNET_ALPHABET
    assert json.loads(je.decrypt(stored)) == plaintext_list


def test_both_derived_list_columns_are_typed_as_encrypted() -> None:
    """The two columns #3263 names are ciphertext, and the helper sees them as such."""
    tables = SQLModel.metadata.tables
    for column in (tables["corpusfragment"].c.embedding, tables["journalentry"].c.vault_tags):
        assert isinstance(column.type, je.EncryptedJSONList)
        assert je.is_encrypted_type(column.type)
        assert isinstance(column.type.impl_instance, je.EncryptedString)


def test_a_plain_text_or_json_column_is_not_encrypted() -> None:
    """The helper is not a blanket ``True``: ordinary columns stay plaintext."""
    assert je.is_encrypted_type(je.EncryptedString())
    assert not je.is_encrypted_type(Text())
    assert not je.is_encrypted_type(String())


@pytest.mark.asyncio
@pytest.mark.usefixtures("_keyed")
async def test_vault_tags_are_ciphertext_at_rest_and_a_list_through_the_model(
    db_session: AsyncSession,
) -> None:
    """Write a list, read the raw row as ciphertext, read the model back as the list."""
    entry = JournalEntry(sender="user", user_id=await _user_id(db_session), message="m")
    entry.vault_tags = list(_TAGS)
    db_session.add(entry)
    await db_session.commit()

    stored = (await db_session.execute(text("SELECT vault_tags FROM journalentry"))).scalar_one()
    _assert_ciphertext_of(stored, list(_TAGS))

    db_session.expunge_all()
    loaded = await db_session.get(JournalEntry, entry.id)
    assert loaded is not None
    assert loaded.vault_tags == _TAGS


@pytest.mark.asyncio
@pytest.mark.usefixtures("_keyed")
async def test_an_embedding_is_ciphertext_at_rest_and_a_list_through_the_model(
    db_session: AsyncSession,
) -> None:
    """Floats survive the JSON round trip exactly, and none is readable at rest."""
    fragment = CorpusFragment(
        user_id=await _user_id(db_session),
        source="journal",
        tier="personal",
        content="c",
        embedding=list(_EMBEDDING),
    )
    db_session.add(fragment)
    await db_session.commit()

    stored = (await db_session.execute(text("SELECT embedding FROM corpusfragment"))).scalar_one()
    _assert_ciphertext_of(stored, list(_EMBEDDING))

    db_session.expunge_all()
    loaded = await db_session.get(CorpusFragment, fragment.id)
    assert loaded is not None
    assert loaded.embedding == _EMBEDDING


@pytest.mark.asyncio
@pytest.mark.usefixtures("_keyed")
async def test_null_stays_null(db_session: AsyncSession) -> None:
    """A row never sent to a vault, or never embedded, stores SQL NULL -- not ``"null"``."""
    user_id = await _user_id(db_session)
    db_session.add(JournalEntry(sender="user", user_id=user_id, message="m"))
    db_session.add(CorpusFragment(user_id=user_id, source="journal", tier="personal", content="c"))
    await db_session.commit()

    tags = (await db_session.execute(text("SELECT vault_tags FROM journalentry"))).scalar_one()
    vector = (await db_session.execute(text("SELECT embedding FROM corpusfragment"))).scalar_one()
    assert tags is None
    assert vector is None


@pytest.mark.asyncio
@pytest.mark.usefixtures("_keyed")
async def test_an_empty_list_is_encrypted_rather_than_collapsed_to_null(
    db_session: AsyncSession,
) -> None:
    """``[]`` (a vault that returned no tags) is a value, distinct from NULL (never sent)."""
    entry = JournalEntry(sender="user", user_id=await _user_id(db_session), message="m")
    entry.vault_tags = []
    db_session.add(entry)
    await db_session.commit()

    stored = (await db_session.execute(text("SELECT vault_tags FROM journalentry"))).scalar_one()
    assert stored.startswith(_MARKER)
    db_session.expunge_all()
    loaded = await db_session.get(JournalEntry, entry.id)
    assert loaded is not None
    assert loaded.vault_tags == []


@pytest.mark.asyncio
@pytest.mark.usefixtures("_keyed")
async def test_a_legacy_plaintext_json_value_still_reads_as_its_list(
    db_session: AsyncSession,
) -> None:
    """A row the sweep has not reached yet holds the old JSON text; it reads unchanged."""
    entry = JournalEntry(sender="user", user_id=await _user_id(db_session), message="m")
    db_session.add(entry)
    await db_session.commit()
    await db_session.execute(
        text("UPDATE journalentry SET vault_tags = :raw"), {"raw": json.dumps(_TAGS)}
    )
    await db_session.commit()

    db_session.expunge_all()
    loaded = await db_session.get(JournalEntry, entry.id)
    assert loaded is not None
    assert loaded.vault_tags == _TAGS


@pytest.mark.usefixtures("_unkeyed")
def test_without_a_key_the_stored_form_is_the_json_text() -> None:
    """Key presence is the switch: un-keyed, the value is the JSON, as before."""
    stored = _bind(list(_TAGS))

    assert stored == json.dumps(_TAGS)
    assert _result(json.dumps(_TAGS)) == _TAGS


@pytest.mark.usefixtures("_unkeyed")
def test_a_stored_value_that_is_not_a_json_list_is_refused() -> None:
    """A scalar or object where a list belongs is corruption, surfaced rather than returned."""
    with pytest.raises(je.JournalEncryptionError, match="not a JSON list"):
        _result('{"F5": 1}')
    with pytest.raises(je.JournalEncryptionError, match="not a JSON list"):
        _result("not json at all")


@pytest.mark.usefixtures("_keyed")
def test_the_refusal_never_carries_the_stored_value() -> None:
    """The error names the problem, not the decrypted content."""
    secret = je.encrypt('"the tag nobody else may read"')

    with pytest.raises(je.JournalEncryptionError, match="not a JSON list") as excinfo:
        _result(secret)

    assert "nobody" not in str(excinfo.value)


@pytest.mark.asyncio
@pytest.mark.usefixtures("_keyed")
async def test_the_type_works_on_a_table_of_its_own(db_session: AsyncSession) -> None:
    """Nothing about the type is specific to the two mapped tables."""
    metadata = MetaData()
    scratch = Table(
        "scratch_3263",
        metadata,
        Column("id", Integer, primary_key=True),
        Column("items", je.EncryptedJSONList()),
    )
    connection = await db_session.connection()
    await connection.run_sync(metadata.create_all)
    await db_session.execute(scratch.insert().values(id=1, items=["a", "b"]))

    raw = (await db_session.execute(text("SELECT items FROM scratch_3263"))).scalar_one()
    typed = (await db_session.execute(scratch.select())).one()

    assert raw.startswith(_MARKER)
    assert typed.items == ["a", "b"]


@pytest.mark.usefixtures("_unkeyed")
def test_a_production_write_without_a_key_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    """The list type inherits the codec's production refusal, so tags never land in the clear."""
    monkeypatch.setenv("ENV", "production")

    with pytest.raises(je.JournalEncryptionError):
        _bind(list(_TAGS))
