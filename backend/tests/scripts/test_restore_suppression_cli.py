"""Meta-test for ``backend/scripts/restore_suppression.py`` (#3063 AC10).

The CLI is what an operator runs between "supply the keys" and "verify before
cutting over" on the worst day of the project. Its exit code is the only signal
a scripted restore reads, so every refusal must be non-zero: a malformed
tombstone file, and a second reapply of a restore that already completed.
"""

from __future__ import annotations

import json
import stat
from http import HTTPStatus
from pathlib import Path

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from scripts import restore_suppression as cli

_PASSWORD = "securepassword123"  # pragma: allowlist secret
_OWNER_ONLY = 0o600


@pytest.fixture
def _cli_factory(
    concurrent_session_factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Point the CLI at the drill database instead of ``DATABASE_URL``."""
    monkeypatch.setattr(cli, "async_session_factory", concurrent_session_factory)


async def _delete_one_account(client: AsyncClient) -> None:
    email = "leaver@example.com"
    resp = await client.post("/auth/signup", json={"email": email, "password": _PASSWORD})
    token = resp.json()["token"]
    resp = await client.request(
        "DELETE",
        "/users/me",
        json={"confirm_email": email},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == HTTPStatus.OK


@pytest.mark.asyncio
@pytest.mark.usefixtures("_cli_factory")
async def test_reapply_rejects_a_malformed_file(tmp_path: Path) -> None:
    """A file that is not a tombstone set exits non-zero and writes nothing."""
    bad = tmp_path / "bad.json"
    bad.write_text('{"version": 1, "accounts": "nope"}', encoding="utf-8")
    assert await cli.run(["reapply", "--in", str(bad), "--restore-id", "x"]) == cli.EXIT_MALFORMED
    missing = tmp_path / "missing.json"
    assert (
        await cli.run(["reapply", "--in", str(missing), "--restore-id", "x"]) == cli.EXIT_MALFORMED
    )


@pytest.mark.asyncio
@pytest.mark.usefixtures("_cli_factory")
async def test_export_then_reapply_then_refuse_a_second_reapply(
    concurrent_async_client: AsyncClient,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Export writes an owner-only file; a completed restore refuses to run twice."""
    await _delete_one_account(concurrent_async_client)
    out = tmp_path / "tombstones.json"

    assert await cli.run(["export", "--out", str(out)]) == 0
    assert stat.S_IMODE(out.stat().st_mode) == _OWNER_ONLY
    document = json.loads(out.read_text(encoding="utf-8"))
    assert len(document["accounts"]) == 1

    assert await cli.run(["reapply", "--in", str(out), "--restore-id", "r1"]) == 0
    assert "accounts_absent=1" in capsys.readouterr().out
    assert await cli.run(["reapply", "--in", str(out), "--restore-id", "r1"]) == cli.EXIT_REFUSED


@pytest.mark.asyncio
@pytest.mark.usefixtures("_cli_factory")
async def test_export_refuses_to_overwrite(tmp_path: Path) -> None:
    """An existing file is never clobbered: it may be the only copy of a tombstone set."""
    out = tmp_path / "tombstones.json"
    out.write_text("{}", encoding="utf-8")
    assert await cli.run(["export", "--out", str(out)]) == cli.EXIT_REFUSED
    assert out.read_text(encoding="utf-8") == "{}"


def test_usage_error_is_not_success() -> None:
    """A missing subcommand is argparse's exit 2, not a silent zero."""
    with pytest.raises(SystemExit) as excinfo:
        cli.parse_args([])
    assert excinfo.value.code != 0
