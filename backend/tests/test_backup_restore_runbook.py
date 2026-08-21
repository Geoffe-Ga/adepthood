"""Drift guards between the backup runbook in ``DEPLOYMENT.md`` and the code.

A restore runbook is a document an operator follows on the worst day of the
project, from a checkout they may not have read, under time pressure. Every
sentence in it that restates something the code owns is a sentence that can rot
into the most authoritative wrong instruction in the repository -- and the
reader has no way to tell, because the only signal that a runbook is stale is
the restore failing.

Four restatements carry the whole procedure and are pinned here from the code
side:

*The key variable.* A restored database is ciphertext until
``JOURNAL_ENCRYPTION_KEYS`` is supplied, and the runbook's central warning names
that variable. Renaming it in code while the runbook still names the old one
would send an operator hunting for a secret that no longer exists.

*The ciphertext marker.* The runbook hands over a SQL query that tells an
encrypted column apart from a plaintext one at a glance, which is how a restore
is verified without a key in hand. The marker in that query is asserted to be a
real prefix of what ``encrypt`` actually produces, not a remembered one.

*The keyless-read error.* The message raised when ciphertext is read with no key
configured is the string an operator greps their logs for during a botched
restore. The runbook quotes it verbatim, so it is built here from the code path
that raises it rather than copied.

*The table and column.* The verification query names a table and its encrypted
column. Both are read off the model, so a rename that misses the runbook fails
here instead of at 3am.

*The shell the operator pastes.* Every command block is meant to be run
verbatim, in order, by someone who did not write it. A variable the procedure
expands but never assigns is therefore not a typo -- it is a step that silently
reaches the wrong database, or none, precisely when nobody has the attention to
spot an empty expansion. Review caught one such name by eye; three more were
undefined on the same page, which is why this is pinned mechanically instead.

The drill record is checked for shape rather than content: a runbook whose
proven-restore claim cites a migration revision that exists in no file is a
claim nobody can retrace.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from pathlib import Path

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import Table, inspect

from models.journal_entry import JournalEntry
from services import journal_encryption
from services.journal_encryption import EncryptedString

_REPO_ROOT = Path(__file__).resolve().parents[2]
_DEPLOYMENT_DOC = _REPO_ROOT / "DEPLOYMENT.md"
_MIGRATIONS_DIR = _REPO_ROOT / "backend" / "migrations" / "versions"

# The runbook's own heading, and the pattern that ends any top-level section.
_SECTION_HEADING = "## Backups and Restore"
_NEXT_SECTION = re.compile(r"^## ", re.MULTILINE)

# Plaintext used only to observe what a real ciphertext looks like.
_PROBE_PLAINTEXT = "runbook drift probe"
# A marker short enough to be a coincidence proves nothing; the real one is
# ``enc::v1::``-length, so this floor only rejects accidental one-character hits.
_MIN_MARKER_LENGTH = 5

# The bolded label carrying the revision the recorded restore was run against.
_DRILL_REVISION = re.compile(r"\*\*Schema at drill time:\*\*\s*`([0-9a-f]+)`")
# ``- **Date performed:** 2026-08-21``
_DRILL_DATE = re.compile(r"\*\*Date performed:\*\*\s*(\d{4}-\d{2}-\d{2})")
# The ``revision: str = "<id>"`` line at the top of every migration file.
_MIGRATION_REVISION = re.compile(r'^revision:\s*str\s*=\s*"([0-9a-z]+)"', re.MULTILINE)

# Both objectives have to be stated for a restore to be plannable at all: how
# much writing may be lost, and how long the app is down while it comes back.
_REQUIRED_OBJECTIVES = ("Recovery point objective", "Recovery time objective")

# Fenced ``bash`` blocks inside the runbook -- the text an operator actually
# pastes, as opposed to prose that merely mentions a variable name.
_BASH_BLOCK = re.compile(r"```bash\n(.*?)```", re.DOTALL)
# ``$VAR`` and ``${VAR}``, but never ``$(command)``.
_SHELL_REFERENCE = re.compile(r"\$\{?([A-Z][A-Z0-9_]*)\}?")
# ``VAR=value`` at a statement start (line start, or after ``;``/``&&``), plus
# the ``read -rs VAR`` form the dump step uses to keep a URL out of history.
_SHELL_ASSIGNMENT = re.compile(
    r"(?:^\s*|[;&|]\s*)([A-Z][A-Z0-9_]*)=|read\s+-\w+\s+([A-Z][A-Z0-9_]*)",
    re.MULTILINE,
)
# Supplied by the environment the operator already has, never by the runbook.
_AMBIENT_SHELL_VARS = frozenset({"HOME", "PATH", "PWD", "SHELL", "USER_ID"})


@pytest.fixture
def runbook() -> str:
    """The ``Backups and Restore`` section of ``DEPLOYMENT.md``, heading to heading."""
    text = _DEPLOYMENT_DOC.read_text(encoding="utf-8")
    start = text.find(_SECTION_HEADING)
    assert start != -1, f"{_DEPLOYMENT_DOC} has no '{_SECTION_HEADING}' section"
    rest = text[start + len(_SECTION_HEADING) :]
    end = _NEXT_SECTION.search(rest)
    return rest[: end.start()] if end else rest


@pytest.fixture
def _keyed(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Configure a throwaway encryption key for the duration of one test."""
    monkeypatch.setenv(journal_encryption.KEYS_ENV_VAR, Fernet.generate_key().decode())
    journal_encryption.reset_cache()
    yield
    journal_encryption.reset_cache()


def _journal_table() -> Table:
    """The mapped journal table, reached through the mapper so it stays typed."""
    table = inspect(JournalEntry).local_table
    assert isinstance(table, Table)
    return table


def _encrypted_column_names() -> list[str]:
    """Names of the journal columns actually encrypted at rest."""
    return [
        column.name
        for column in _journal_table().columns
        if isinstance(column.type, EncryptedString)
    ]


def _known_revisions() -> set[str]:
    """Every Alembic revision id present in ``migrations/versions``."""
    return {
        match.group(1)
        for path in _MIGRATIONS_DIR.glob("*.py")
        for match in _MIGRATION_REVISION.finditer(path.read_text(encoding="utf-8"))
    }


def test_runbook_names_the_key_variable_the_code_reads(runbook: str) -> None:
    """The custody warning names the variable the decrypting code actually reads."""
    assert journal_encryption.KEYS_ENV_VAR in runbook


@pytest.mark.usefixtures("_keyed")
def test_runbook_quotes_the_marker_the_ciphertext_carries(runbook: str) -> None:
    """The 'is this row encrypted?' query matches what ``encrypt`` really emits."""
    ciphertext = journal_encryption.encrypt(_PROBE_PLAINTEXT)
    quoted = re.findall(r"`([^`\n]+)`", runbook)
    markers = [
        token
        for token in quoted
        if len(token) >= _MIN_MARKER_LENGTH and ciphertext.startswith(token)
    ]
    assert markers, (
        "the runbook quotes no marker that real ciphertext starts with; "
        f"ciphertext looks like {ciphertext[:24]!r}"
    )


@pytest.mark.usefixtures("_keyed")
def test_runbook_quotes_the_error_a_keyless_read_raises(
    runbook: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The runbook quotes, verbatim, the failure an operator greps for."""
    ciphertext = journal_encryption.encrypt(_PROBE_PLAINTEXT)
    monkeypatch.delenv(journal_encryption.KEYS_ENV_VAR, raising=False)
    journal_encryption.reset_cache()
    with pytest.raises(journal_encryption.JournalEncryptionError) as excinfo:
        journal_encryption.decrypt(ciphertext)
    assert str(excinfo.value) in runbook


def test_runbook_names_the_encrypted_table_and_column(runbook: str) -> None:
    """The verification query names the real table and every encrypted column."""
    assert _journal_table().name in runbook
    columns = _encrypted_column_names()
    assert columns, "no JournalEntry column is encrypted -- this guard is vacuous"
    missing = [name for name in columns if name not in runbook]
    assert not missing, f"runbook omits encrypted column(s): {missing}"


def test_runbook_records_a_drill_against_a_real_revision(runbook: str) -> None:
    """The proven-restore record cites a date and a revision that exists on disk."""
    assert _DRILL_DATE.search(runbook), "the runbook records no drill date"
    revision_match = _DRILL_REVISION.search(runbook)
    assert revision_match, "the runbook records no schema revision for the drill"
    assert revision_match.group(1) in _known_revisions()


def test_runbook_states_recovery_objectives(runbook: str) -> None:
    """Both objectives are stated, so a restore can be planned rather than hoped."""
    missing = [name for name in _REQUIRED_OBJECTIVES if name not in runbook]
    assert not missing, f"runbook states no {missing}"


def test_every_variable_the_runbook_expands_is_one_it_also_assigns(runbook: str) -> None:
    """No command block expands a name the procedure never sets.

    An operator pastes these blocks in order under pressure. An unset variable
    does not announce itself -- ``psql -h "" -p "" -d ""`` fails obscurely, and
    a half-defined connection can reach a *different* database that answers
    normally. The restore steps once mixed two connection idioms and expanded
    four names the document never assigned, which is the failure this pins shut.
    """
    blocks = _BASH_BLOCK.findall(runbook)
    assert blocks, "the runbook has no ``bash`` command blocks to check"

    shell = "\n".join(blocks)
    assigned = {name for pair in _SHELL_ASSIGNMENT.findall(shell) for name in pair if name}
    referenced = set(_SHELL_REFERENCE.findall(shell))

    undefined = sorted(referenced - assigned - _AMBIENT_SHELL_VARS)
    assert not undefined, (
        f"the runbook expands {undefined} but never assigns them; "
        "an operator pasting these blocks would run them empty"
    )
