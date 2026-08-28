"""Per-user Creek Vault configuration: each user reaches their own vault, or none.

The seam this pins is the *own-vault* one, which is a different thing from the
shared-vault partitioning the ``/v1`` contract genuinely cannot express. Nobody
is asking Creek to keep two users apart inside one corpus here; each user
supplies the URL of a vault that is already theirs alone, plus the credential
that opens it, so there is nothing to disambiguate and no tenant field to want.

Four families.

*Storage.* The credential is a third-party secret at rest, so it is ciphertext
in the column and absent from every response body. Both are asserted against
the raw stored bytes and the real HTTP responses rather than through an ORM
round-trip, which would pass just as happily against a plaintext column.

*Resolution.* The request-time dependency hands each caller the vault their own
row names, the deployment-wide default only to a caller who has connected
nothing, and the local fallback to everyone else -- including the caller whose
own stored URL turns out to be unusable, whose degrade must not touch anybody
else.

*Validation.* A URL is judged by the same classifier the deployment-wide path
uses, on write, so an unusable one is refused where the person who typed it can
see the refusal. A credential that could not survive an HTTP header is refused
for the same reason.

*Isolation.* Two users, two vaults, one app: the end-to-end leg asserts each
user's writing reaches only their own vault, which is the whole property the
feature exists for.
"""

from __future__ import annotations

from collections.abc import Iterator
from http import HTTPStatus

import pytest
import sqlalchemy as sa
from cryptography.fernet import Fernet
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import col, select

from dependencies.creek_vault import get_creek_vault_client
from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapability,
    CreekVaultClient,
    HandshakeResult,
    VaultIngestRequest,
    VaultIngestResult,
)
from models.user_vault_config import VAULT_URL_MAX_LENGTH, UserVaultConfig
from schemas.vault_config import VAULT_API_KEY_MAX_LENGTH
from services import creek_vault_client as vault_client_module
from services import creek_vault_url_resolution, journal_encryption
from services.creek_vault_client import HttpCreekVaultClient, LocalFallbackCreekVaultClient

# The marker real ciphertext carries. Imported as a literal rather than off the
# private constant so this file states, independently, what "encrypted at rest"
# is supposed to look like in the column.
_CIPHERTEXT_MARKER = "enc::v1::"

_CONNECTION_PATH = "/vault/connection"

_VAULT_A_URL = "https://vault-alpha.example.test"
_VAULT_B_URL = "https://vault-beta.example.test"

# Two credentials that share no substring, so "A's key never appears" cannot be
# satisfied by B's key happening to contain it.
_KEY_A = "alpha-credential-never-leaves-the-column"  # pragma: allowlist secret
_KEY_B = "beta-credential-never-leaves-the-column"  # pragma: allowlist secret

_SIGNUP_PASSWORD = "secret12345"  # pragma: allowlist secret

# A credential distinctive enough that finding it in a 422 body can only mean the
# body repeated what was submitted. Every refusal test below is written against
# it rather than against a plausible-looking key, because "the response does not
# echo the secret" is only an assertion when the secret is unmistakable.
_SENTINEL_KEY = "SENTINEL-CREDENTIAL-MUST-NOT-BE-ECHOED"  # pragma: allowlist secret

# The refusal code a caller sees for a credential no ``Authorization`` header
# could carry. A code rather than a validator's prose, because the prose that
# used to carry this refusal arrived with the submitted value attached.
_KEY_REFUSAL = "vault_key_unusable"

# Two bodies past the schema's own ceilings, which is the one class of refusal
# the router never sees: the request is rejected before any handler runs, so
# whatever the framework puts in that body is what the client gets.
_OVER_LONG_URL = f"https://{'a' * VAULT_URL_MAX_LENGTH}.example.test"
_OVER_LONG_KEY = _SENTINEL_KEY * (1 + VAULT_API_KEY_MAX_LENGTH // len(_SENTINEL_KEY))

_ALPHA_SENTINEL = "alpha-writing-belongs-only-to-alphas-vault"
_BETA_SENTINEL = "beta-writing-belongs-only-to-betas-vault"


@pytest.fixture
def _keyed(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Configure a throwaway encryption key for the duration of one test.

    Without it ``EncryptedString`` passes plaintext straight through -- the
    honest "no key configured" behaviour -- and every at-rest assertion in this
    module would be testing nothing.
    """
    monkeypatch.setenv(journal_encryption.KEYS_ENV_VAR, Fernet.generate_key().decode())
    journal_encryption.reset_cache()
    yield
    journal_encryption.reset_cache()


@pytest.fixture(autouse=True)
def _no_deployment_vault(monkeypatch: pytest.MonkeyPatch) -> None:
    """Clear the deployment-wide vault variables so per-user resolution is what is read.

    A developer's own environment carrying a real ``CREEK_VAULT_URL`` would
    otherwise decide these assertions, and the one test that *is* about the
    deployment default sets them back deliberately.
    """
    for name in (
        "CREEK_VAULT_URL",
        "CREEK_VAULT_API_KEY",
        "CREEK_VAULT_PROTOCOL",
        "CREEK_VAULT_OWNER_USER_ID",
    ):
        monkeypatch.delenv(name, raising=False)


# The address every stubbed lookup in this module answers with. Globally
# routable on purpose: a user-supplied vault URL is judged by where it points,
# and documentation ranges are not routable, so a stub answering with one would
# have every connection in this file refused for the wrong reason.
_PUBLIC_ADDRESS = "8.8.8.8"


async def _resolves_publicly(_host: str) -> tuple[str, ...]:
    """Answer any name with an ordinary public address."""
    return (_PUBLIC_ADDRESS,)


@pytest.fixture(autouse=True)
def _resolvable_hosts(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Answer name lookups from the test rather than from whatever DNS is nearby.

    A user-supplied vault URL is refused unless its host resolves somewhere
    globally routable, and refused when it does not resolve at all -- fail
    closed, because a name nobody can answer is a destination nobody has
    checked. Every vault in this module lives under ``.example.test``, which is
    reserved precisely so that it never resolves, so without this fixture the
    whole file would be asserting the request-forgery guard instead of the
    per-user feature it exists for.

    The cache is cleared on both sides. Its entries outlive a test by a minute of
    wall-clock time, which is longer than this suite takes, so a leaked answer is
    a real ordering dependency rather than a theoretical one -- and it would
    surface as a failure in whichever test happened to run next.
    """
    creek_vault_url_resolution.reset_resolution_cache()
    monkeypatch.setattr(creek_vault_url_resolution, "resolve_host_addresses", _resolves_publicly)
    yield
    creek_vault_url_resolution.reset_resolution_cache()


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    """Sign up a fresh user and return its auth header and DB-assigned id."""
    resp = await client.post(
        "/auth/signup",
        json={"email": f"{username}@example.com", "password": _SIGNUP_PASSWORD},
    )
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    return {"Authorization": f"Bearer {body['token']}"}, int(body["user_id"])


async def _connect(
    client: AsyncClient, headers: dict[str, str], url: str, api_key: str
) -> dict[str, object]:
    """Connect one user's own vault and return the response body."""
    resp = await client.put(
        _CONNECTION_PATH,
        json={"vault_url": url, "api_key": api_key},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK, resp.text
    body: dict[str, object] = resp.json()
    return body


async def _stored_api_key(session: AsyncSession, user_id: int) -> str:
    """Read the credential column exactly as the database holds it.

    Raw SQL on purpose: reading it back through the ORM would decrypt on the way
    out and report success against an unencrypted column.
    """
    result = await session.execute(
        sa.text("SELECT api_key FROM uservaultconfig WHERE user_id = :user_id"),
        {"user_id": user_id},
    )
    return str(result.scalar_one())


async def _client_for(session: AsyncSession, user_id: int) -> CreekVaultClient:
    """Resolve the vault client the request-time dependency hands ``user_id``."""
    return await get_creek_vault_client(user_id, session)


# ---------------------------------------------------------------------------
# Storage: the credential at rest and in every response
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.usefixtures("_keyed")
async def test_the_stored_credential_is_ciphertext_in_the_column(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The credential column holds a marked ciphertext, not the key that was sent.

    Asserted against the bytes the database actually holds, because an ORM
    round-trip proves only that the value survived the trip -- which it does
    whether or not anything encrypted it.
    """
    headers, user_id = await _signup(async_client, "vault_owner")
    await _connect(async_client, headers, _VAULT_A_URL, _KEY_A)

    stored = await _stored_api_key(db_session, user_id)

    assert stored.startswith(_CIPHERTEXT_MARKER), "the credential column holds plaintext"
    assert _KEY_A not in stored


@pytest.mark.asyncio
@pytest.mark.usefixtures("_keyed")
async def test_the_credential_never_appears_in_any_response_body(
    async_client: AsyncClient,
) -> None:
    """Neither the write that set the credential nor any later read echoes it back.

    Write-only is the whole contract of this field: a client that has just sent
    the key does not need it returned, and a client that has not sent it must
    never be able to fetch one.
    """
    headers, _user_id = await _signup(async_client, "vault_owner")

    written = await async_client.put(
        _CONNECTION_PATH,
        json={"vault_url": _VAULT_A_URL, "api_key": _KEY_A},
        headers=headers,
    )
    read = await async_client.get(_CONNECTION_PATH, headers=headers)

    assert written.status_code == HTTPStatus.OK
    assert read.status_code == HTTPStatus.OK
    assert _KEY_A not in written.text
    assert _KEY_A not in read.text
    assert "api_key" not in read.json()
    assert read.json()["vault_url"] == _VAULT_A_URL


@pytest.mark.asyncio
@pytest.mark.usefixtures("_keyed")
async def test_the_round_trip_still_hands_the_real_credential_to_the_vault(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Encryption is reversible where it has to be: the adapter gets the true key.

    The complement of the at-rest test. Ciphertext in the column would be worth
    nothing if the value the request path recovered were not the key the user
    typed, so the recovered credential is checked at the one place it is used.
    """
    headers, user_id = await _signup(async_client, "vault_owner")
    await _connect(async_client, headers, _VAULT_A_URL, _KEY_A)

    row = (
        await db_session.execute(
            select(UserVaultConfig).where(col(UserVaultConfig.user_id) == user_id)
        )
    ).scalar_one()

    assert row.api_key == _KEY_A


# ---------------------------------------------------------------------------
# Resolution: which client each caller is handed
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.usefixtures("_keyed")
async def test_each_user_is_handed_the_vault_their_own_row_names(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Two connected users, two adapters, each pointed at its owner's own URL."""
    alpha_headers, alpha_id = await _signup(async_client, "alpha")
    beta_headers, beta_id = await _signup(async_client, "beta")
    await _connect(async_client, alpha_headers, _VAULT_A_URL, _KEY_A)
    await _connect(async_client, beta_headers, _VAULT_B_URL, _KEY_B)

    alpha_client = await _client_for(db_session, alpha_id)
    beta_client = await _client_for(db_session, beta_id)

    assert isinstance(alpha_client, HttpCreekVaultClient)
    assert isinstance(beta_client, HttpCreekVaultClient)
    assert alpha_client.base_url == _VAULT_A_URL
    assert beta_client.base_url == _VAULT_B_URL


@pytest.mark.asyncio
async def test_a_user_who_connected_nothing_gets_the_local_fallback(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The floor is unchanged: no connection, no vault, no error."""
    _headers, user_id = await _signup(async_client, "unconnected")

    assert isinstance(await _client_for(db_session, user_id), LocalFallbackCreekVaultClient)


@pytest.mark.asyncio
@pytest.mark.usefixtures("_keyed")
async def test_removing_a_connection_returns_that_user_to_the_fallback(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Disconnecting is real: the row goes, and so does the vault behind the client."""
    headers, user_id = await _signup(async_client, "alpha")
    await _connect(async_client, headers, _VAULT_A_URL, _KEY_A)
    assert isinstance(await _client_for(db_session, user_id), HttpCreekVaultClient)

    removed = await async_client.delete(_CONNECTION_PATH, headers=headers)

    assert removed.status_code == HTTPStatus.NO_CONTENT
    assert isinstance(await _client_for(db_session, user_id), LocalFallbackCreekVaultClient)
    after = await async_client.get(_CONNECTION_PATH, headers=headers)
    assert after.json() == {"connected": False, "vault_url": None}


@pytest.mark.asyncio
@pytest.mark.usefixtures("_keyed")
async def test_reconnecting_replaces_the_stored_vault_rather_than_adding_one(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A second connect is an update: one user has at most one vault."""
    headers, user_id = await _signup(async_client, "alpha")
    await _connect(async_client, headers, _VAULT_A_URL, _KEY_A)

    await _connect(async_client, headers, _VAULT_B_URL, _KEY_B)

    rows = (
        (
            await db_session.execute(
                select(UserVaultConfig).where(col(UserVaultConfig.user_id) == user_id)
            )
        )
        .scalars()
        .all()
    )
    assert len(rows) == 1
    assert rows[0].vault_url == _VAULT_B_URL
    assert rows[0].api_key == _KEY_B


@pytest.mark.asyncio
@pytest.mark.usefixtures("_keyed")
async def test_one_users_unusable_stored_url_degrades_only_that_user(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A broken vault costs its owner the capability and costs nobody else anything.

    The bad row is planted directly, because the write path refuses it -- which
    is the point: this covers the row that got there some other way (a restored
    backup, a rule tightened after the row was written), and proves the request
    path degrades rather than raising for it.
    """
    alpha_headers, alpha_id = await _signup(async_client, "alpha")
    beta_headers, beta_id = await _signup(async_client, "beta")
    await _connect(async_client, beta_headers, _VAULT_B_URL, _KEY_B)
    db_session.add(
        UserVaultConfig(user_id=alpha_id, vault_url="http://vault.example.test", api_key=_KEY_A)
    )
    await db_session.commit()

    alpha_client = await _client_for(db_session, alpha_id)
    beta_client = await _client_for(db_session, beta_id)

    assert isinstance(alpha_client, LocalFallbackCreekVaultClient)
    assert isinstance(beta_client, HttpCreekVaultClient)
    assert beta_client.base_url == _VAULT_B_URL
    # The owner still gets an answer rather than a 500 on their own request path.
    entry = await async_client.post(
        "/journal/",
        json={"message": f"still saved. {_ALPHA_SENTINEL}", "classification": "personal"},
        headers=alpha_headers,
    )
    assert entry.status_code == HTTPStatus.CREATED


@pytest.mark.asyncio
async def test_the_deployment_default_still_serves_a_user_who_connected_nothing(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The env-var path survives one release as a deployment-wide default.

    An operator who has not migrated their users yet keeps exactly the behaviour
    they had: the bound owner reaches the deployment's vault, everyone else does
    not.
    """
    _owner_headers, owner_id = await _signup(async_client, "owner")
    _other_headers, other_id = await _signup(async_client, "other")
    monkeypatch.setenv("CREEK_VAULT_URL", _VAULT_A_URL)
    monkeypatch.setenv("CREEK_VAULT_API_KEY", _KEY_A)
    monkeypatch.setenv("CREEK_VAULT_OWNER_USER_ID", str(owner_id))

    assert isinstance(await _client_for(db_session, owner_id), HttpCreekVaultClient)
    assert isinstance(await _client_for(db_session, other_id), LocalFallbackCreekVaultClient)


@pytest.mark.asyncio
@pytest.mark.usefixtures("_keyed")
async def test_a_users_own_connection_outranks_the_deployment_default(
    async_client: AsyncClient, db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A user who connected their own vault reaches theirs, not the deployment's.

    This is the direction the migration runs in: an operator turns the
    deployment-wide binding off by having every user connect their own, and a
    user who already has must never be silently handed somebody else's corpus.
    """
    headers, user_id = await _signup(async_client, "alpha")
    await _connect(async_client, headers, _VAULT_A_URL, _KEY_A)
    monkeypatch.setenv("CREEK_VAULT_URL", _VAULT_B_URL)
    monkeypatch.setenv("CREEK_VAULT_API_KEY", _KEY_B)
    monkeypatch.setenv("CREEK_VAULT_OWNER_USER_ID", str(user_id))

    resolved = await _client_for(db_session, user_id)

    assert isinstance(resolved, HttpCreekVaultClient)
    assert resolved.base_url == _VAULT_A_URL


# ---------------------------------------------------------------------------
# Validation on write
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("url", "reason"),
    [
        ("http://vault.example.test", "plaintext to a remote host would expose the credential"),
        # Fake userinfo, present precisely because the classifier must refuse it:
        # httpx renders that prefix unmasked in its own request log and derives a
        # BasicAuth from it that would replace our bearer.
        (
            "https://user:pw@vault.example.test",  # pragma: allowlist secret
            "userinfo is itself a credential",
        ),
        ("https://vault.example.test/?", "a query delimiter swallows the capability path"),
        ("https://vault.example.test/#f", "a fragment swallows the capability path"),
        ("https://", "no host at all"),
        ("not a url", "no scheme and no host"),
        ("", "nothing was configured"),
    ],
)
@pytest.mark.asyncio
@pytest.mark.usefixtures("_keyed")
async def test_an_unusable_url_is_refused_on_write(
    async_client: AsyncClient, db_session: AsyncSession, url: str, reason: str
) -> None:
    """Every URL the seam's own classifier refuses is refused here, and stored nowhere.

    Judged by ``classify_vault_url`` rather than by a second set of rules
    written for this endpoint, so a URL cannot be accepted here and then
    refused at request time.
    """
    headers, user_id = await _signup(async_client, "alpha")

    resp = await async_client.put(
        _CONNECTION_PATH, json={"vault_url": url, "api_key": _KEY_A}, headers=headers
    )

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY, reason
    assert _KEY_A not in resp.text
    stored = (
        await db_session.execute(
            select(UserVaultConfig).where(col(UserVaultConfig.user_id) == user_id)
        )
    ).first()
    assert stored is None, "a refused connection must leave no row behind"


@pytest.mark.parametrize(
    ("api_key", "reason"),
    [
        ("", "there is no credential at all"),
        ("   ", "whitespace trims away to nothing"),
        (f"{_SENTINEL_KEY} with a space", "a space cannot appear inside a bearer credential"),
        (f"{_SENTINEL_KEY}\nwith-a-newline", "httpx refuses to build a header holding one"),
        (f"{_SENTINEL_KEY}\twith-a-tab", "a tab is a control character in a field value"),
        (f"{_SENTINEL_KEY}é", "a non-ASCII letter cannot be encoded into a field value"),
    ],
)
@pytest.mark.asyncio
@pytest.mark.usefixtures("_keyed")
async def test_a_credential_that_could_not_survive_a_header_is_refused(
    async_client: AsyncClient, api_key: str, reason: str
) -> None:
    """The credential is destined for an ``Authorization`` header, so it must fit one.

    A stored newline is the load-bearing case: httpx refuses to build a request
    from it, and that refusal is not in any degrade set -- so a key accepted here
    would turn every one of that user's journal saves into a 500 rather than an
    optional capability quietly skipped.

    What the refusal *says* is the second half, and it is a security property
    rather than an ergonomic one. This is the one field on this request that is a
    secret, and a rejection describing it by quoting it puts that secret into a
    422 body, into whatever the client logs, and into whatever sits between them.
    So the refusal is a code this endpoint owns, and the submitted value appears
    nowhere in the response.
    """
    headers, _user_id = await _signup(async_client, "alpha")

    resp = await async_client.put(
        _CONNECTION_PATH, json={"vault_url": _VAULT_A_URL, "api_key": api_key}, headers=headers
    )

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY, reason
    assert resp.json()["detail"] == _KEY_REFUSAL
    assert _SENTINEL_KEY not in resp.text


@pytest.mark.parametrize(
    ("body", "reason"),
    [
        ({"vault_url": _OVER_LONG_URL, "api_key": _SENTINEL_KEY}, "the URL is past its ceiling"),
        (
            {"vault_url": _VAULT_A_URL, "api_key": _OVER_LONG_KEY},
            "the credential is past its ceiling",
        ),
    ],
)
@pytest.mark.asyncio
@pytest.mark.usefixtures("_keyed")
async def test_a_schema_refusal_names_the_field_without_repeating_what_was_sent(
    async_client: AsyncClient, body: dict[str, str], reason: str
) -> None:
    """A 422 raised before any handler runs still must not carry the request back.

    This is the refusal no router-level check can reach. Both bodies are rejected
    by the request schema itself, so nothing in this application's own code has
    executed by the time the response is written -- which means the only place the
    submitted credential can be stripped from it is a handler installed over the
    framework's validation error, and this is the test that says so.

    The shape is kept: still 422, still a list under ``detail``, still one entry
    per problem naming its type, its location and a human-readable message. What
    goes is ``input``, which is a verbatim copy of what the client sent, and
    ``ctx``, which carries the validator's own state. A client debugging a
    rejected request already has the body it sent; the server repeating it is
    pure downside on a request whose whole purpose is to carry a secret.
    """
    headers, _user_id = await _signup(async_client, "alpha")

    resp = await async_client.put(_CONNECTION_PATH, json=body, headers=headers)

    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY, reason
    assert _SENTINEL_KEY not in resp.text
    detail = resp.json()["detail"]
    assert isinstance(detail, list)
    assert detail
    for entry in detail:
        assert set(entry) <= {"type", "loc", "msg"}, "a 422 entry carried more than it should"
        assert entry["type"]
        assert entry["loc"]
        assert entry["msg"]


@pytest.mark.asyncio
@pytest.mark.usefixtures("_keyed")
async def test_a_surrounding_newline_on_a_pasted_credential_is_forgiven(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Whitespace around a pasted key is trimmed rather than refused.

    A trailing newline is what a terminal copy hands over, and it cannot be part
    of a credential a header could ever carry, so trimming it changes nothing
    about which secret was meant. Whitespace *inside* the value is a different
    matter and is refused above.
    """
    headers, user_id = await _signup(async_client, "alpha")

    resp = await async_client.put(
        _CONNECTION_PATH,
        json={"vault_url": _VAULT_A_URL, "api_key": f"  {_KEY_A}\n"},
        headers=headers,
    )

    assert resp.status_code == HTTPStatus.OK
    row = (
        await db_session.execute(
            select(UserVaultConfig).where(col(UserVaultConfig.user_id) == user_id)
        )
    ).scalar_one()
    assert row.api_key == _KEY_A


@pytest.mark.asyncio
async def test_the_connection_endpoints_require_authentication(
    async_client: AsyncClient,
) -> None:
    """No caller reaches anybody's vault configuration without presenting a token."""
    assert (await async_client.get(_CONNECTION_PATH)).status_code == HTTPStatus.UNAUTHORIZED
    written = await async_client.put(
        _CONNECTION_PATH, json={"vault_url": _VAULT_A_URL, "api_key": _KEY_A}
    )
    assert written.status_code == HTTPStatus.UNAUTHORIZED
    assert (await async_client.delete(_CONNECTION_PATH)).status_code == HTTPStatus.UNAUTHORIZED


@pytest.mark.asyncio
@pytest.mark.usefixtures("_keyed")
async def test_one_users_connection_is_invisible_to_another(async_client: AsyncClient) -> None:
    """No user_id is accepted from anywhere, so nobody can read or write another's row."""
    alpha_headers, _alpha_id = await _signup(async_client, "alpha")
    beta_headers, _beta_id = await _signup(async_client, "beta")
    await _connect(async_client, alpha_headers, _VAULT_A_URL, _KEY_A)

    seen = await async_client.get(_CONNECTION_PATH, headers=beta_headers)

    assert seen.status_code == HTTPStatus.OK
    assert seen.json() == {"connected": False, "vault_url": None}
    assert _VAULT_A_URL not in seen.text


# ---------------------------------------------------------------------------
# Isolation, end to end
# ---------------------------------------------------------------------------


class _RecordingVault:
    """One vault instance, standing in for the transport of exactly one URL.

    It records what was ingested, so "alpha's writing reached beta's vault" is a
    thing the assertions can see rather than something the fake has to be told
    to simulate.
    """

    def __init__(self, url: str, api_key: str) -> None:
        """Remember which vault this is and which credential opened it."""
        self.url = url
        self.api_key = api_key
        self.ingested: list[str] = []

    async def handshake(self) -> HandshakeResult:
        """Report a vault that can ingest."""
        return HandshakeResult(
            available=True,
            contract_version=CONTRACT_VERSION,
            ontology_version="1.0.0",
            capabilities=frozenset({CreekCapability.JOURNAL}),
            attestation=None,
        )

    def is_available(self) -> bool:
        """Report available -- this fake never degrades."""
        return True

    def supports(self, capability: CreekCapability, /) -> bool:
        """Report journal ingest as the one capability this stand-in serves."""
        return capability is CreekCapability.JOURNAL

    async def ingest(self, request: VaultIngestRequest, /) -> VaultIngestResult:
        """Record the body and answer with a stored ref."""
        self.ingested.append(request.body)
        return VaultIngestResult(stored=True, vault_ref=f"ref-{len(self.ingested)}")


@pytest.mark.asyncio
@pytest.mark.usefixtures("_keyed")
async def test_one_users_writing_only_ever_reaches_their_own_vault(
    async_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Two users, two connected vaults: neither corpus ever sees the other's writing.

    Driven through the real endpoints and the real resolution -- only the
    transport is faked, and it is faked *per URL*, so a resolution that handed
    one user the other's adapter would show up as a body in the wrong vault
    rather than as a passing test.
    """
    vaults: dict[str, _RecordingVault] = {}

    def _fake_transport(url: str, api_key: str, **_kwargs: object) -> _RecordingVault:
        vault = vaults.setdefault(url, _RecordingVault(url, api_key))
        vault.api_key = api_key
        return vault

    monkeypatch.setattr(vault_client_module, "HttpCreekVaultClient", _fake_transport)
    alpha_headers, _alpha_id = await _signup(async_client, "alpha")
    beta_headers, _beta_id = await _signup(async_client, "beta")
    await _connect(async_client, alpha_headers, _VAULT_A_URL, _KEY_A)
    await _connect(async_client, beta_headers, _VAULT_B_URL, _KEY_B)

    for headers, sentinel in ((alpha_headers, _ALPHA_SENTINEL), (beta_headers, _BETA_SENTINEL)):
        created = await async_client.post(
            "/journal/",
            json={"message": f"I noticed something. {sentinel}", "classification": "personal"},
            headers=headers,
        )
        assert created.status_code == HTTPStatus.CREATED

    assert set(vaults) == {_VAULT_A_URL, _VAULT_B_URL}
    alpha_vault, beta_vault = vaults[_VAULT_A_URL], vaults[_VAULT_B_URL]
    assert alpha_vault.api_key == _KEY_A
    assert beta_vault.api_key == _KEY_B
    assert any(_ALPHA_SENTINEL in body for body in alpha_vault.ingested)
    assert any(_BETA_SENTINEL in body for body in beta_vault.ingested)
    assert not any(_BETA_SENTINEL in body for body in alpha_vault.ingested)
    assert not any(_ALPHA_SENTINEL in body for body in beta_vault.ingested)
