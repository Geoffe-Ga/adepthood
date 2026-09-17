"""Order this account's outbound writes against its own erasure and liveness.

The journal database and Creek cannot participate in one transaction, so a
journal write that has already been admitted can still be mid-flight when the
same account's ``DELETE /users/me`` returns its receipt. Nothing at HEAD made
those two agree on an order, and the observable consequence was a receipt that
said "erased" followed by this account's plaintext being handed to Creek.

These tests drive both requests concurrently through the real routers against a
scripted vault double and assert the one property the barrier exists to supply:
**no vault write is recorded after the deletion response**. They are written
against the HTTP seam rather than against the serializer, because a lock that
one of two racing parties takes orders nothing, and only a test that drives both
parties can tell the difference.
"""

from __future__ import annotations

import asyncio
from http import HTTPStatus

import pytest
from httpx import AsyncClient, Response

from dependencies.creek_vault import get_creek_vault_client
from domain.creek_vault import VaultIngestRequest, VaultIngestResult
from main import app
from tests.test_journal_vault_write import SequencedVaultClient

_SIGNUP_PASSWORD = "secret12345"  # pragma: allowlist secret

#: Markers appended to the shared order list. Named once so an assertion and
#: the double cannot drift apart on a typo.
INGEST_START = "ingest-start"
INGEST_SENT = "ingest-sent"
DELETION_BEGIN = "deletion-begin"
DELETION_RESPONSE = "deletion-response-200"

#: A settle bound for a concurrent pair. Long enough that a slow machine is not
#: mistaken for a deadlock, short enough that a real deadlock fails the suite
#: rather than hanging it.
_SETTLE_TIMEOUT_SECONDS = 20.0

#: How long the deletion is given to overtake a paused ingest. Without the
#: barrier it runs to completion well inside this window -- that is the measured
#: defect. With the barrier it is still waiting when the window closes, and the
#: paused writer is then released to finish first. Generous, because a window
#: too short would make an unbarriered deletion look ordered.
_OVERTAKE_PROBE_SECONDS = 1.0


class PausedFirstIngest(SequencedVaultClient):
    """Hold the first ingest open so a deletion can try to overtake it.

    ``order`` is instance-local and the two events are instance-local, so the
    test carries no module state and its result does not depend on the order
    pytest happens to run the file in.
    """

    def __init__(self) -> None:
        """Start with an empty order list and both synchronization points clear."""
        super().__init__()
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.order: list[str] = []

    async def ingest(self, request: VaultIngestRequest, /) -> VaultIngestResult:
        """Announce arrival, wait to be released, then record the transmission."""
        if not self.started.is_set():
            self.order.append(INGEST_START)
            self.started.set()
            await self.release.wait()
        self.order.append(INGEST_SENT)
        return await super().ingest(request)


async def signup(client: AsyncClient, username: str) -> tuple[dict[str, str], str]:
    """Sign up a fresh account and return its auth header and email address."""
    email = f"{username}@example.com"
    resp = await client.post("/auth/signup", json={"email": email, "password": _SIGNUP_PASSWORD})
    assert resp.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {resp.json()['token']}"}, email


async def delete_account_recording_order(
    client: AsyncClient,
    headers: dict[str, str],
    email: str,
    order: list[str],
) -> Response:
    """Erase the account and stamp the exact moment its receipt came back."""
    response = await client.request(
        "DELETE", "/users/me", json={"confirm_email": email}, headers=headers
    )
    order.append(f"deletion-response-{response.status_code}")
    return response


@pytest.mark.asyncio
async def test_deletion_response_is_never_followed_by_a_vault_write(
    concurrent_async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A journal body already in flight cannot reach Creek after the receipt."""
    fake = PausedFirstIngest()
    monkeypatch.setitem(app.dependency_overrides, get_creek_vault_client, lambda: fake)
    headers, email = await signup(concurrent_async_client, "egress_race")

    writing = asyncio.create_task(
        concurrent_async_client.post(
            "/journal/",
            json={"message": "A body that must not outlive me.", "classification": "personal"},
            headers=headers,
        )
    )
    await fake.started.wait()
    fake.order.append(DELETION_BEGIN)
    deleting = asyncio.create_task(
        delete_account_recording_order(concurrent_async_client, headers, email, fake.order)
    )
    # Give the deletion its best chance to overtake: it is released to run while
    # the ingest is still held open, and only once it has had that window does
    # the writer resume. At HEAD the deletion finishes inside the window.
    await asyncio.wait({deleting}, timeout=_OVERTAKE_PROBE_SECONDS)
    fake.release.set()
    _written, deleted = await asyncio.wait_for(
        asyncio.gather(writing, deleting), timeout=_SETTLE_TIMEOUT_SECONDS
    )
    assert deleted.status_code == HTTPStatus.OK

    assert INGEST_SENT not in fake.order[fake.order.index(DELETION_RESPONSE) :], (
        f"a journal body was handed to Creek after the account-deletion response: {fake.order}"
    )
