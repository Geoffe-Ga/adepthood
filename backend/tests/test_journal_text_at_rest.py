"""Every column that holds journal text must hold ciphertext, not plaintext.

``journalentry.message`` has been encrypted at rest since audit-destub-05b, but
the same sentences are copied into other tables — a margin note snapshots the
passage it anchors to, a completion suggestion snapshots the passage it claims
attests to a habit, a promoted quote snapshots the passage the user lifted. A
copy stored in the clear beside the ciphertext is the copy a stolen dump yields,
so the encryption of the source column is worth only what the least-protected
copy is worth.

Two guards, because each catches what the other cannot.

*The inventory guard* pins the exact set of ``table.column`` names that carry
ciphertext, in both directions. A new journal-text column that ships plaintext
fails here, and so does an encrypted column quietly reverted to plaintext — the
failure mode nothing else in the suite can see, because an ORM round-trip reads
identically either way.

*The raw-SQL guards* bypass the ORM entirely and read the bytes the database
actually stores. An ORM round-trip proves only that ``EncryptedString`` is a
faithful codec; it passes just as green against an unencrypted column. Reading
the raw column is the only assertion that tells the two apart.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, date, datetime
from http import HTTPStatus

import pytest
from cryptography.fernet import Fernet
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import SQLModel

from models.completion_suggestion import CompletionSuggestion, CompletionTargetType
from models.goal import Goal
from models.habit import Habit
from models.journal_entry import JournalEntry
from models.marginalia import Marginalia, MarginaliaKind
from models.user import User
from services import journal_encryption as je
from services.journal_encryption import EncryptedString

# The literal marker real ciphertext carries. Spelled out rather than imported
# from ``journal_encryption._PREFIX`` so this file pins the on-disk format
# itself: a change to the private constant should fail here, not pass silently.
_MARKER = "enc::v1::"

# Every ``table.column`` in the live schema that must store ciphertext, with the
# journal text each one holds. A column that snapshots, quotes, or paraphrases a
# journal entry belongs here *and* must be typed ``EncryptedString``.
_JOURNAL_TEXT_COLUMNS: frozenset[str] = frozenset(
    {
        # The entry body, and the title the user gave it.
        "journalentry.message",
        "journalentry.title",
        # A passage the user lifted out of one entry to carry into another.
        "promotedquote.anchor_text",
        # The passage a margin note anchors to, plus the note and the essay
        # written about it (both quote and paraphrase that passage).
        "marginalia.anchor_text",
        "marginalia.note",
        "marginalia.essay",
        # The passage a completion suggestion claims attests to a habit, and the
        # label — which is that same passage, sanitized.
        "completionsuggestion.anchor_text",
        "completionsuggestion.label",
        # A weekly prompt response, written into journalentry.message
        # byte-for-byte in the same transaction. (``question`` is the shared
        # curriculum's prompt, not the user's writing, and stays plaintext.)
        "promptresponse.response",
        # The ontologized copy of an entry, held for retrieval.
        "corpusfragment.content",
    }
)

# Columns encrypted for a reason other than holding journal text. They are named
# here rather than folded into the set above because the distinction is the
# whole subject of this module: the argument for encrypting journal text is that
# a plaintext copy beside the ciphertext is the copy a stolen dump yields, and
# that argument does not apply to a value the user never wrote. Keeping them
# apart is what lets the inventory above stay readable as "the journal's own
# text" while the assertion below still refuses to let any encrypted column go
# undeclared.
_OTHER_ENCRYPTED_COLUMNS: frozenset[str] = frozenset(
    {
        # A credential for a third-party service the user connected. Encrypted
        # because it is a live secret at rest, not because it is anyone's
        # writing.
        "uservaultconfig.api_key",
    }
)

_ANCHOR = "the willow bending without breaking"
_NOTE = "A recurring image of yielding strength."
_ESSAY = "The willow is this entry's whole argument, in one plant."
_TITLE = "What I could not say out loud"
_PROMPT_RESPONSE = "The week I stopped pretending it was fine."
_ANCHOR_START = 11


@pytest.fixture
def _keyed(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Configure a throwaway encryption key for the duration of one test.

    The key registry is process-cached on purpose (rotation is a deploy-time
    operation), so it is reset on both sides or later tests read the wrong
    answer.
    """
    monkeypatch.setenv(je.KEYS_ENV_VAR, Fernet.generate_key().decode())
    je.reset_cache()
    yield
    je.reset_cache()


def _encrypted_columns() -> frozenset[str]:
    """Every ``table.column`` in the live schema typed as ``EncryptedString``."""
    return frozenset(
        f"{table.name}.{column.name}"
        for table in SQLModel.metadata.tables.values()
        for column in table.columns
        if isinstance(column.type, EncryptedString)
    )


async def _user(session: AsyncSession, email: str = "atrest@example.com") -> int:
    """Insert a user row and return its id."""
    user = User(email=email, password_hash="x")  # pragma: allowlist secret
    session.add(user)
    await session.flush()
    assert user.id is not None
    return user.id


async def _entry(session: AsyncSession, user_id: int) -> int:
    """Insert a titled journal entry whose body contains ``_ANCHOR``."""
    entry = JournalEntry(
        sender="user",
        user_id=user_id,
        message=f"I noticed {_ANCHOR}, and something settled.",
        title=_TITLE,
    )
    session.add(entry)
    await session.flush()
    assert entry.id is not None
    return entry.id


async def _goal(session: AsyncSession, user_id: int) -> int:
    """Insert a habit + goal for a completion suggestion to point at."""
    habit = Habit(
        name="Walk",
        icon="🚶",
        start_date=date(2025, 1, 1),
        energy_cost=10,
        energy_return=20,
        user_id=user_id,
    )
    session.add(habit)
    await session.flush()
    goal = Goal(
        habit_id=habit.id,
        title="Daily walk",
        tier="clear",
        target=1.0,
        target_unit="walk",
        frequency=1.0,
        frequency_unit="per_day",
        is_additive=True,
    )
    session.add(goal)
    await session.flush()
    assert goal.id is not None
    return goal.id


# Raw reads, one literal statement per column, so the assertion never depends on
# the ORM type that is under test here.
_RAW_READS: dict[str, str] = {
    "journalentry.message": "SELECT message FROM journalentry",
    "journalentry.title": "SELECT title FROM journalentry",
    "promptresponse.response": "SELECT response FROM promptresponse",
    "marginalia.anchor_text": "SELECT anchor_text FROM marginalia",
    "marginalia.note": "SELECT note FROM marginalia",
    "marginalia.essay": "SELECT essay FROM marginalia",
    "completionsuggestion.anchor_text": "SELECT anchor_text FROM completionsuggestion",
    "completionsuggestion.label": "SELECT label FROM completionsuggestion",
}


async def _raw(session: AsyncSession, column: str) -> str | None:
    """Read one column of the single row in its table with raw SQL, no ORM."""
    stored: str | None = (await session.execute(text(_RAW_READS[column]))).scalar_one()
    return stored


def _assert_ciphertext_of(stored: str | None, plaintext: str, where: str) -> None:
    """Assert the raw bytes are marked ciphertext that decrypts to ``plaintext``."""
    assert stored is not None, f"{where} stored NULL"
    assert stored.startswith(_MARKER), f"{where} is stored in the clear: {stored[:40]!r}"
    assert plaintext not in stored, f"{where} leaks its plaintext"
    assert je.decrypt(stored) == plaintext, f"{where} does not decrypt to what was written"


def test_the_pinned_inventory_is_exactly_what_the_schema_encrypts() -> None:
    """The set of encrypted columns matches the inventory, in both directions.

    A journal-text column that ships plaintext, and an encrypted column quietly
    reverted to plaintext, both fail here — the second being the one an ORM
    round-trip cannot see.

    The comparison is against both inventories together rather than against
    ``_JOURNAL_TEXT_COLUMNS`` alone, so that a column encrypted for some *other*
    reason has to be declared as such instead of quietly widening the set this
    module is named after. A subset check would have been the smaller edit and
    the wrong one: it would stop failing when a genuinely new encrypted column
    appeared, which is half of what this guard is for.
    """
    assert _encrypted_columns() == _JOURNAL_TEXT_COLUMNS | _OTHER_ENCRYPTED_COLUMNS


@pytest.mark.asyncio
@pytest.mark.usefixtures("_keyed")
async def test_marginalia_text_is_ciphertext_in_the_raw_columns(
    db_session: AsyncSession,
) -> None:
    """The bytes stored for a margin note carry the marker, not the passage."""
    user_id = await _user(db_session)
    entry_id = await _entry(db_session, user_id)
    db_session.add(
        Marginalia(
            journal_entry_id=entry_id,
            user_id=user_id,
            kind=MarginaliaKind.SYMBOL,
            anchor_start=_ANCHOR_START,
            anchor_end=_ANCHOR_START + len(_ANCHOR),
            anchor_text=_ANCHOR,
            note=_NOTE,
            essay=_ESSAY,
            # essay and its timestamp are set together or the paired CHECK fires.
            essay_generated_at=datetime.now(UTC),
        )
    )
    await db_session.commit()

    for column, plaintext in (
        ("marginalia.anchor_text", _ANCHOR),
        ("marginalia.note", _NOTE),
        ("marginalia.essay", _ESSAY),
    ):
        _assert_ciphertext_of(await _raw(db_session, column), plaintext, column)


@pytest.mark.asyncio
@pytest.mark.usefixtures("_keyed")
async def test_completion_suggestion_text_is_ciphertext_in_the_raw_columns(
    db_session: AsyncSession,
) -> None:
    """The bytes stored for a suggestion carry the marker, not the passage."""
    user_id = await _user(db_session)
    entry_id = await _entry(db_session, user_id)
    goal_id = await _goal(db_session, user_id)
    db_session.add(
        CompletionSuggestion(
            journal_entry_id=entry_id,
            user_id=user_id,
            target_type=CompletionTargetType.HABIT,
            goal_id=goal_id,
            label=_ANCHOR,
            anchor_start=_ANCHOR_START,
            anchor_end=_ANCHOR_START + len(_ANCHOR),
            anchor_text=_ANCHOR,
        )
    )
    await db_session.commit()

    for column in ("completionsuggestion.anchor_text", "completionsuggestion.label"):
        _assert_ciphertext_of(await _raw(db_session, column), _ANCHOR, column)


@pytest.mark.asyncio
@pytest.mark.usefixtures("_keyed")
async def test_journal_title_is_ciphertext_in_the_raw_column(
    db_session: AsyncSession,
) -> None:
    """An entry's title is as revealing as its body, and is stored the same way."""
    user_id = await _user(db_session)
    await _entry(db_session, user_id)
    await db_session.commit()

    stored = await _raw(db_session, "journalentry.title")
    _assert_ciphertext_of(stored, _TITLE, "journalentry.title")


@pytest.mark.asyncio
@pytest.mark.usefixtures("_keyed")
async def test_a_prompt_response_is_ciphertext_in_both_rows_it_writes(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Submitting a weekly prompt leaves no plaintext copy of what was written.

    The endpoint writes the same sanitized string into ``promptresponse`` and
    ``journalentry`` in one transaction, so this goes through the real route
    rather than constructing rows: an encrypted body beside a plaintext
    duplicate is precisely the seam being closed, and only the endpoint proves
    both halves.
    """
    signup = await async_client.post(
        "/auth/signup",
        json={
            "email": "prompt-at-rest@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert signup.status_code == HTTPStatus.OK
    headers = {"Authorization": f"Bearer {signup.json()['token']}"}

    submitted = await async_client.post(
        "/prompts/1/respond",
        json={"response": _PROMPT_RESPONSE},
        headers=headers,
    )
    assert submitted.status_code == HTTPStatus.CREATED

    for column in ("promptresponse.response", "journalentry.message"):
        stored = await _raw(db_session, column)
        _assert_ciphertext_of(stored, _PROMPT_RESPONSE, column)


@pytest.mark.asyncio
@pytest.mark.usefixtures("_keyed")
async def test_an_untitled_entry_stores_null_not_ciphertext(
    db_session: AsyncSession,
) -> None:
    """A NULL title stays NULL — encryption must not manufacture a value."""
    user_id = await _user(db_session)
    entry = JournalEntry(sender="user", user_id=user_id, message="No title today.")
    db_session.add(entry)
    await db_session.commit()

    assert await _raw(db_session, "journalentry.title") is None
