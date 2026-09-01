"""A user-supplied vault URL is a dial the API server makes on the user's behalf.

``PUT /vault/connection`` stores a URL that the server itself connects to on
every journal save, carrying the bearer credential the same request supplied.
That is a request-forgery primitive by construction: whoever can set the URL
chooses which host an authenticated, server-side connection is opened to, and
inside a deployment that host can be a cloud metadata endpoint, an unauthenticated
Redis or Elasticsearch on the loopback interface, or anything else on the private
network the process happens to sit on. The stored string is the whole of the
attack surface, so it is judged before it is stored.

Two rule sets, and keeping them apart is the point of this file rather than an
implementation detail. :func:`~services.creek_vault_url.classify_vault_url` judges
the *operator's* deployment-wide ``CREEK_VAULT_URL`` and exempts loopback: a
developer running a vault on the same machine is the documented local setup, and
the operator already owns the process, so nothing is escalated by letting them
name their own host. A URL that arrived in a request body is a different value
with a different threat model, so it gets the stricter rules in
:mod:`services.creek_vault_url_user` on top -- and the test that the operator path
still accepts loopback is here precisely so a fix to the second cannot quietly
narrow the first.

Both ends are pinned, because either alone leaves the hole open. Write time
refuses, so the person who typed the URL sees the refusal instead of a connection
that silently never works, and no row is left behind. Dial time re-checks and
degrades to the local fallback, because a row can reach the database some other
way -- a restored backup, DNS that resolved publicly on Tuesday and privately on
Wednesday -- and because a per-request dependency that raises costs the writer
the entry they were saving. A user's bad vault must cost them the capability and
never their writing.

Resolution is stubbed throughout. A test that consulted the real resolver would
be asserting something about the network the suite happens to run on, and the
DNS-rebinding cases could not be expressed at all.
"""

from __future__ import annotations

import socket
from collections.abc import Awaitable, Callable, Iterator
from http import HTTPStatus

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from dependencies.creek_vault import get_creek_vault_client
from domain.creek_vault import CreekVaultClient
from models.user_vault_config import UserVaultConfig
from services import creek_vault_url_resolution
from services.creek_vault_client import (
    HttpCreekVaultClient,
    LocalFallbackCreekVaultClient,
    build_creek_vault_client,
    unusable_creek_vault_url,
)
from services.creek_vault_url import classify_vault_url

_CONNECTION_PATH = "/vault/connection"
_JOURNAL_PATH = "/journal/"

_SIGNUP_PASSWORD = "secret12345"  # pragma: allowlist secret

# The credential every refusal in this file is checked against. Distinctive
# enough that finding it in a response body can only mean the body repeated what
# was submitted, and header-safe so it is never the *reason* a request is
# refused -- every 422 below is about the URL.
_SENTINEL_KEY = "SSRF-SENTINEL-CREDENTIAL-DO-NOT-ECHO"  # pragma: allowlist secret

# A genuinely globally-routable address, used wherever a stubbed lookup has to
# stand for "an ordinary public host". Documentation ranges are the tempting
# choice here and are wrong: ``ipaddress`` reports TEST-NET-1/2/3 and
# ``2001:db8::/32`` as not globally routable, so a correct guard blocks them and
# every happy path built on one would fail against working code.
_GLOBAL_ADDRESS = "8.8.8.8"

# The address a rebinding stub answers with: RFC 1918 space, reachable from
# inside a deployment and from nowhere else.
_PRIVATE_ADDRESS = "10.0.0.7"

# A name with nothing suspicious about its spelling. It exists to prove the
# guard is not a string match: this host is refused for what it resolves to.
_ORDINARY_LOOKING_HOST = "vault.example.com"

_PUBLIC_VAULT_URL = f"https://{_ORDINARY_LOOKING_HOST}"

# The refusal codes a client sees. Asserted as literals rather than imported
# from the router, so this file states the contract independently of whatever
# the router happens to build it from.
_PRIVATE_ADDRESS_REFUSAL = "vault_url_private_address"
_UNRESOLVABLE_REFUSAL = "vault_url_unresolvable_host"
_FORBIDDEN_COMPONENTS_REFUSAL = "vault_url_forbidden_components"

# The operator's own loopback vault: the documented local-development setup,
# which the deployment-wide classifier must keep accepting.
_OPERATOR_LOOPBACK_URL = "http://127.0.0.1:8000"

# Every class of destination a user-supplied URL must never name, one case each,
# paired with what makes it dangerous. The two literal forms of the same
# metadata address are both here on purpose: an IPv4-mapped IPv6 literal is the
# same destination wearing a different spelling.
_BLOCKED_URLS = [
    ("https://169.254.169.254", "the cloud instance metadata endpoint"),
    ("https://metadata.google.internal", "the metadata endpoint reached by name"),
    ("https://10.0.0.7:8080", "RFC 1918 private space"),
    ("http://127.0.0.1:9200", "an unauthenticated search node on the loopback interface"),
    ("http://[::1]:6379", "an unauthenticated cache on the IPv6 loopback"),
    ("https://192.168.1.5", "the other RFC 1918 block a home or office network uses"),
    ("https://172.16.0.1", "the third RFC 1918 block"),
    ("https://100.64.0.1", "carrier-grade NAT space"),
    ("https://[fe80::1]", "an IPv6 link-local neighbour"),
    ("https://[fc00::1]", "an IPv6 unique-local address"),
    ("https://0.0.0.0", "the unspecified address, which resolves to this host"),
    ("https://[::ffff:169.254.169.254]", "the metadata endpoint as an IPv4-mapped literal"),
    ("https://vault.local", "the multicast-DNS zone, which names a machine on this LAN"),
    ("https://backend.internal", "an internal-only zone naming a service behind the perimeter"),
    ("https://localhost", "this process's own host, by its most ordinary name"),
]


def _resolving_to(*addresses: str) -> Callable[[str], Awaitable[tuple[str, ...]]]:
    """Build a resolver stub that answers every name with ``addresses``."""

    async def _stub(_host: str) -> tuple[str, ...]:
        return addresses

    return _stub


async def _resolving_nowhere(_host: str) -> tuple[str, ...]:
    """Stand in for a name the resolver cannot answer at all.

    ``socket.gaierror`` is what the real lookup raises for NXDOMAIN and for a
    resolver that is simply unreachable, and the guard must not be able to tell
    those apart: both mean nobody knows where this URL points, and a destination
    nobody can name is a destination nobody has checked.
    """
    raise socket.gaierror(socket.EAI_NONAME, "stubbed lookup failure")


def _repoint_resolver(
    monkeypatch: pytest.MonkeyPatch, resolver: Callable[[str], Awaitable[tuple[str, ...]]]
) -> None:
    """Point the resolver seam at ``resolver`` and drop whatever was cached before.

    The cache drop is not optional. Every test in this file has already been
    handed a stubbed resolver by the autouse fixture, so a name looked up before
    this call would answer from the previous stub for the next minute and the
    test would be asserting against an answer it thinks it replaced.
    """
    monkeypatch.setattr(creek_vault_url_resolution, "resolve_host_addresses", resolver)
    creek_vault_url_resolution.reset_resolution_cache()


@pytest.fixture(autouse=True)
def _stubbed_resolution(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Answer every name lookup from the test rather than from the network.

    The cache is cleared on both sides of the test, not just before. Entries
    live for a minute of wall-clock time, which is longer than this suite takes,
    so one test's stubbed answer surviving into the next is a real ordering
    dependency rather than a theoretical one -- and it would show up as a flake
    whose cause is somewhere other than the test that failed.
    """
    creek_vault_url_resolution.reset_resolution_cache()
    monkeypatch.setattr(
        creek_vault_url_resolution, "resolve_host_addresses", _resolving_to(_GLOBAL_ADDRESS)
    )
    yield
    creek_vault_url_resolution.reset_resolution_cache()


@pytest.fixture(autouse=True)
def _no_deployment_vault(monkeypatch: pytest.MonkeyPatch) -> None:
    """Clear the deployment-wide vault variables so the per-user path is what is judged.

    A developer's own environment carrying a real ``CREEK_VAULT_URL`` would
    otherwise decide these assertions, and the one test that is *about* the
    operator's variable sets it back deliberately.
    """
    for name in (
        "CREEK_VAULT_URL",
        "CREEK_VAULT_API_KEY",
        "CREEK_VAULT_PROTOCOL",
        "CREEK_VAULT_OWNER_USER_ID",
    ):
        monkeypatch.delenv(name, raising=False)


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    """Sign up a fresh user and return its auth header and DB-assigned id."""
    resp = await client.post(
        "/auth/signup",
        json={"email": f"{username}@example.com", "password": _SIGNUP_PASSWORD},
    )
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    return {"Authorization": f"Bearer {body['token']}"}, int(body["user_id"])


async def _stored_row(session: AsyncSession, user_id: int) -> UserVaultConfig | None:
    """Read this user's connection row straight from the table.

    Asked of the database rather than of ``GET /vault/connection``, because the
    property under test is that nothing was *written*: a handler that stored a
    row and then declined to report it would satisfy the endpoint and not this.
    """
    result = await session.execute(
        select(UserVaultConfig).where(col(UserVaultConfig.user_id) == user_id)
    )
    return result.scalars().first()


async def _plant_connection(session: AsyncSession, user_id: int, vault_url: str) -> None:
    """Write a connection row the write path would have refused.

    Direct insertion is the only way to reach the dial-time guard, and that is
    exactly the case worth covering: a row that got into the table some other
    way -- a restored backup, a rule tightened after it was written, a name that
    used to resolve elsewhere.
    """
    session.add(UserVaultConfig(user_id=user_id, vault_url=vault_url, api_key=_SENTINEL_KEY))
    await session.commit()


async def _client_for(session: AsyncSession, user_id: int) -> CreekVaultClient:
    """Resolve the vault client the request-time dependency hands ``user_id``."""
    return await get_creek_vault_client(user_id, session)


async def _save_an_entry(client: AsyncClient, headers: dict[str, str]) -> int:
    """Write one journal entry as this user and return the status code.

    The whole point of every degrade in this seam: the status is the assertion,
    because a vault that cannot be dialled must cost its owner an optional
    capability and never the writing they just did.
    """
    resp = await client.post(
        _JOURNAL_PATH,
        json={
            "message": "The kettle boiled while I was still deciding.",
            "classification": "personal",
        },
        headers=headers,
    )
    return resp.status_code


# ---------------------------------------------------------------------------
# Write time: the refusal, and the row that is not there
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(("url", "reason"), _BLOCKED_URLS)
@pytest.mark.asyncio
async def test_a_url_naming_a_private_destination_is_refused_and_stored_nowhere(
    async_client: AsyncClient, db_session: AsyncSession, url: str, reason: str
) -> None:
    """No user-supplied URL may name a host only this deployment can reach.

    One case per class of destination rather than one representative, because
    these are separate rules that fail separately: a guard that catches loopback
    and misses link-local leaves the metadata endpoint open, and a guard written
    for IPv4 alone leaves every IPv6 form of the same host open.

    Three things are asserted together and all three are load-bearing. The
    status and the code are what a client renders. The absent row is what makes
    the refusal a refusal: a URL that is rejected in the response and stored
    anyway is still dialled on the next journal save.
    """
    headers, user_id = await _signup(async_client, "alpha")

    resp = await async_client.put(
        _CONNECTION_PATH, json={"vault_url": url, "api_key": _SENTINEL_KEY}, headers=headers
    )

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY, reason
    assert resp.json()["detail"] == _PRIVATE_ADDRESS_REFUSAL
    assert _SENTINEL_KEY not in resp.text
    assert await _stored_row(db_session, user_id) is None, "a refused URL must leave no row"


@pytest.mark.asyncio
async def test_a_name_that_resolves_into_private_space_is_refused(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The guard judges the destination, not the spelling of the URL.

    This is the case that proves string matching is not enough. Nothing about
    ``vault.example.com`` looks internal; it is refused because the resolver
    says it points at RFC 1918 space, which is the only fact that matters when
    the server is the one opening the connection.
    """
    headers, user_id = await _signup(async_client, "alpha")
    _repoint_resolver(monkeypatch, _resolving_to(_PRIVATE_ADDRESS))

    resp = await async_client.put(
        _CONNECTION_PATH,
        json={"vault_url": _PUBLIC_VAULT_URL, "api_key": _SENTINEL_KEY},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json()["detail"] == _PRIVATE_ADDRESS_REFUSAL
    assert _SENTINEL_KEY not in resp.text
    assert await _stored_row(db_session, user_id) is None


@pytest.mark.asyncio
async def test_a_host_that_does_not_resolve_is_refused_rather_than_trusted(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Fail closed: a destination nobody can name is a destination nobody has checked.

    Accepting an unresolvable host is the obvious-looking kindness and it is the
    bypass. A name that answers NXDOMAIN now can be made to answer ``10.0.0.7``
    later by whoever controls the zone, and by then the URL is already stored and
    already being dialled with the user's credential attached.
    """
    headers, user_id = await _signup(async_client, "alpha")
    _repoint_resolver(monkeypatch, _resolving_nowhere)

    resp = await async_client.put(
        _CONNECTION_PATH,
        json={"vault_url": _PUBLIC_VAULT_URL, "api_key": _SENTINEL_KEY},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json()["detail"] == _UNRESOLVABLE_REFUSAL
    assert _SENTINEL_KEY not in resp.text
    assert await _stored_row(db_session, user_id) is None


@pytest.mark.asyncio
async def test_an_ordinary_public_vault_is_still_connectable(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The guard refuses private destinations, not vaults.

    Without this the whole file is satisfied by a handler that returns 422 to
    everybody, which would close the hole by removing the feature. The stored
    row is checked too, so "accepted" means the connection actually exists.
    """
    headers, user_id = await _signup(async_client, "alpha")

    resp = await async_client.put(
        _CONNECTION_PATH,
        json={"vault_url": _PUBLIC_VAULT_URL, "api_key": _SENTINEL_KEY},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.OK, resp.text
    row = await _stored_row(db_session, user_id)
    assert row is not None
    assert row.vault_url == _PUBLIC_VAULT_URL


@pytest.mark.asyncio
async def test_userinfo_is_named_before_the_host_it_hides_behind(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The shared rules run first, so a credential in the URL is what gets reported.

    A userinfo prefix in front of a private address is two defects at once, and
    only one of them may be named. Userinfo wins because it is itself a
    credential -- httpx renders it unmasked in its own request log and derives a
    ``BasicAuth`` from it that would displace the bearer -- and because a finding
    may only quote a host once
    the parse it came from is known not to contain a secret. A new guard that
    ran first would silently reorder that.
    """
    headers, user_id = await _signup(async_client, "alpha")

    resp = await async_client.put(
        _CONNECTION_PATH,
        json={
            "vault_url": f"https://user:pw@{_PRIVATE_ADDRESS}",  # pragma: allowlist secret
            "api_key": _SENTINEL_KEY,
        },
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert resp.json()["detail"] == _FORBIDDEN_COMPONENTS_REFUSAL
    assert await _stored_row(db_session, user_id) is None


# ---------------------------------------------------------------------------
# The operator's own variable, which these rules must not touch
# ---------------------------------------------------------------------------


def test_the_operator_deployment_variable_still_accepts_a_loopback_vault(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``CREEK_VAULT_URL`` may still name loopback, and that exemption is deliberate.

    The two configurations are not the same value and must not share one rule
    set. ``CREEK_VAULT_URL`` is set by whoever runs the process, on the machine
    the process runs on; they can already reach every host it could name, so
    nothing is escalated by letting them point the vault at ``127.0.0.1``. That
    is the documented local-vault setup -- run a vault on your laptop, point the
    backend at it -- and it is the arrangement every developer uses.

    A URL that arrived in a request body is a different value: it is chosen by
    someone with no access to the deployment's network, and letting them name
    loopback hands them a connection the server makes for them.

    So this test is the one that stops the fix from being over-broad. The
    tempting shape is a single stricter classifier applied everywhere, which
    passes every other test in this file and breaks local development for
    everyone -- silently, since the vault would simply stop replicating.
    """
    monkeypatch.setenv("CREEK_VAULT_URL", _OPERATOR_LOOPBACK_URL)
    monkeypatch.setenv("CREEK_VAULT_API_KEY", _SENTINEL_KEY)
    monkeypatch.delenv("CREEK_VAULT_PROTOCOL", raising=False)

    assert classify_vault_url(_OPERATOR_LOOPBACK_URL) is None
    assert unusable_creek_vault_url() is None
    assert isinstance(build_creek_vault_client(), HttpCreekVaultClient)


# ---------------------------------------------------------------------------
# Dial time: the row that is already there
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_stored_private_literal_degrades_the_dial_and_keeps_the_entry(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A private URL already in the table is not dialled, and its owner still writes.

    Write-time refusal is not enough on its own: rows predate rules. The dial
    has to re-ask, and it has to answer by degrading rather than raising, because
    it runs inside a per-request dependency -- a raise there means the handler
    body never executes and the entry the writer just typed is lost to save them
    from a connection they never see.
    """
    headers, user_id = await _signup(async_client, "alpha")
    await _plant_connection(db_session, user_id, f"https://{_PRIVATE_ADDRESS}")

    resolved = await _client_for(db_session, user_id)

    assert isinstance(resolved, LocalFallbackCreekVaultClient)
    assert await _save_an_entry(async_client, headers) == HTTPStatus.CREATED


@pytest.mark.asyncio
async def test_a_stored_name_that_starts_resolving_privately_degrades_the_dial(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A URL accepted on Tuesday is re-judged on Wednesday, against the same rules.

    Nothing about the stored string changes here -- only the answer the resolver
    gives for it. That is DNS rebinding stated plainly: the check at write time
    can be passed with a public address and the dial made against a private one,
    so the dial is where the second check has to be. The owner keeps their entry;
    what they lose is the vault.
    """
    headers, user_id = await _signup(async_client, "alpha")
    await _plant_connection(db_session, user_id, _PUBLIC_VAULT_URL)
    assert isinstance(await _client_for(db_session, user_id), HttpCreekVaultClient)

    _repoint_resolver(monkeypatch, _resolving_to(_PRIVATE_ADDRESS))

    assert isinstance(await _client_for(db_session, user_id), LocalFallbackCreekVaultClient)
    assert await _save_an_entry(async_client, headers) == HTTPStatus.CREATED


@pytest.mark.asyncio
async def test_the_verdict_cache_stays_bounded_under_a_burst_of_distinct_names() -> None:
    """A flood of unrelated hostnames cannot grow the verdict map without limit.

    Expiry alone does not bound this map, and the difference matters because the
    names are chosen by the caller. Every verdict inside the window is still
    live, so a caller sending a stream of distinct hosts would add one entry
    each and none of them would age out until the window turned over -- a memory
    lever handed to exactly the person the rest of this module exists to refuse.
    The ceiling is what turns that into a bounded cost, so it is asserted here
    rather than left to the docstring that claims it.
    """
    ceiling = creek_vault_url_resolution.MAX_CACHED_HOSTS

    for index in range(ceiling * 2):
        await creek_vault_url_resolution.classify_resolved_user_vault_url(f"host-{index}.example")
        assert creek_vault_url_resolution.cached_host_count() <= ceiling
