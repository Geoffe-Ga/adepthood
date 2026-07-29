"""Sign in with Apple tests for POST /auth/oauth/apple.

Apple's ``id_token`` is the same OIDC shape Google's is, with three quirks that
each become an account-takeover or data-loss bug if they are mishandled:

* ``email_verified`` (and ``is_private_email``) arrive as the *strings*
  ``"true"`` / ``"false"`` rather than JSON booleans, and Apple sometimes sends
  a real boolean instead. Both spellings have to mean the same thing, and the
  false spellings must stay false.
* ``email`` is present only on the very first authorization. Every later
  sign-in carries a ``sub`` and nothing else, so a lookup keyed on email would
  strand the account after its first login.
* the user's name is never in the token at all. It arrives once, in the
  request body's ``full_name``, and is never sent again -- so it is written at
  account creation and no later request may ever overwrite it.

Everything here runs offline: Apple's JWKS client and the outbound Gumroad
verify are both replaced with in-process stubs, and the raw ``id_token`` -- a
replayable credential -- is never allowed to reach a log line or a response
body.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from http import HTTPStatus
from typing import TYPE_CHECKING
from urllib.parse import urlparse

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from sqlalchemy import func
from sqlmodel import SQLModel, select

from domain.entitlements import PRODUCT_IDS_ENV_VAR
from models.auth_identity import AuthIdentity, AuthProvider
from models.entitlement import Entitlement
from models.user import User
from schemas.gumroad import GumroadLicenseResult, GumroadPurchase
from services.oauth_apple import (
    APPLE_ISSUERS,
    APPLE_JWKS_URL,
    APPLE_OAUTH_CLIENT_IDS_ENV_VAR,
    build_jwk_client,
)
from services.oauth_google import GOOGLE_OAUTH_CLIENT_IDS_ENV_VAR
from services.oidc import JWKS_TIMEOUT_SECONDS

if TYPE_CHECKING:
    from httpx import AsyncClient, Response
    from sqlalchemy.ext.asyncio import AsyncSession

pytestmark = pytest.mark.real_license_gate

OAUTH_PATH = "/auth/oauth/apple"
GOOGLE_OAUTH_PATH = "/auth/oauth/google"

# Test seams. The JWKS seam is the only thing standing between this suite and a
# live network fetch of Apple's signing keys, so every test replaces it.
JWKS_SEAM = "services.oauth_apple._get_jwk_client"
GOOGLE_JWKS_SEAM = "services.oauth_google._get_jwk_client"
VERIFY_SEAM = "domain.entitlements.verify_license"

ALLOWED_PRODUCT = "prod_alpha"
ALLOWLIST = ALLOWED_PRODUCT

# Apple audiences: the iOS bundle id plus the Services id used by the web flow.
BUNDLE_ID = "com.adepthood.app"
SERVICES_ID = "com.adepthood.web"
CONFIGURED_CLIENT_IDS = f"{BUNDLE_ID},{SERVICES_ID}"
OTHER_CLIENT_ID = "com.attacker.app"

GOOGLE_CLIENT_ID = "1000000001-adepthood.apps.googleusercontent.com"  # pragma: allowlist secret
GOOGLE_ISSUER = "https://accounts.google.com"

TEST_KID = "adepthood-apple-test-signing-key"
APPLE_ISSUER = "https://appleid.apple.com"
APPLE_HOST = "appleid.apple.com"
EVIL_ISSUER = "https://evil.example.com"

RS256_ALGORITHM = "RS256"
RSA_PUBLIC_EXPONENT = 65537
RSA_KEY_SIZE = 2048

TOKEN_LIFETIME = timedelta(minutes=5)
JUST_ISSUED = timedelta(seconds=1)
EXPIRED_ISSUED_AGO = timedelta(hours=2)
EXPIRED_EXPIRY_AGO = timedelta(hours=1)

EXISTING_EMAIL = "seeker@example.com"
NEW_EMAIL = "newcomer@example.com"
SECOND_NEW_EMAIL = "second-newcomer@example.com"
RELAY_EMAIL = "a1b2c3d4e5@privaterelay.appleid.com"

# Apple subjects are opaque ~44 character strings, not digits like Google's.
KNOWN_SUBJECT = "000123.4c8f1a2b3d4e5f60718293a4b5c6d7e8.0001"
FRESH_SUBJECT = "000124.5d9e2b3c4f506172839405a6b7c8d9e0.0002"
NEW_SUBJECT = "000125.6ea3c4d5e6f70819202a3b4c5d6e7f80.0003"
RELAY_SUBJECT = "000126.7fb4d5e6f708192a3b4c5d6e7f809012.0004"
UNVERIFIED_SUBJECT = "000127.80c5e6f7089a1b2c3d4e5f60718293a4.0005"
NO_LICENSE_SUBJECT = "000128.91d6f708192a3b4c5d6e7f8091a2b3c4.0006"
LINKED_SUBJECT = "000129.a2e708192a3b4c5d6e7f8091a2b3c4d5.0007"
GOOGLE_SUBJECT = "109876543210987654321"

VALID_LICENSE_KEY = "AAAA1111-BBBB-2222-APPLE"  # pragma: allowlist secret
RELAY_LICENSE_KEY = "CCCC3333-DDDD-4444-APPLE"  # pragma: allowlist secret
SALE_ID = "S-APPLE-1"
LICENSE_USES = 1
COURSE_ACCESS_KIND = "course_access"

SEEDED_PASSWORD_HASH = (
    "$2b$12$seededplaceholderdigestforteststhatneveraccepts"  # pragma: allowlist secret
)
SEEDED_TIMEZONE = "America/New_York"
SIGNUP_TIMEZONE = "America/Los_Angeles"

FULL_NAME = "Ada Lovelace"
PADDED_FULL_NAME = "  Ada Lovelace  "
# The stored display name's ceiling. One character past it must be refused at
# the schema boundary, so no over-long name can reach a column that would
# silently truncate it into a name its owner never chose.
DISPLAY_NAME_CEILING = 120
OVERLONG_FULL_NAME = "A" * (DISPLAY_NAME_CEILING + 1)
IMPOSTOR_NAME = "Someone Else Entirely"
SEEDED_DISPLAY_NAME = "Seeker Of Old"

VERIFIED_TRUE_STRING = "true"
VERIFIED_FALSE_STRING = "false"

DETAIL_INVALID_TOKEN = "invalid_oauth_token"
DETAIL_NEEDS_LICENSE = "needs_license"

REASON_INVALID_TOKEN = "oauth_invalid_token"
REASON_LOGIN = "oauth_login"
REASON_LINKED = "oauth_linked"
REASON_SIGNUP = "oauth_signup"

JWT_SEGMENT_COUNT = 3
SOLE_APPLE_ISSUER_COUNT = 1
OAUTH_RATE_LIMIT_PER_MINUTE = 5
BYTE_IDENTICAL_REJECTIONS = 2
DUAL_IDENTITY_COUNT = 2

# Upper bounds the JWKS client must stay inside. An unbounded fetch timeout
# parks a worker in the same default thread pool bcrypt runs in, an unbounded
# key cache grows on a stream of junk ``kid`` values, and an unbounded key-set
# lifespan means a rotated Apple key needs a restart to be picked up.
MAX_ACCEPTABLE_JWKS_TIMEOUT = 10.0
MAX_ACCEPTABLE_CACHED_KEYS = 128
MAX_ACCEPTABLE_JWKS_LIFESPAN = 86400.0

# One 2048-bit keypair per module: generation is expensive enough that doing it
# per test would dominate the suite's runtime. The second, unrelated key exists
# only to forge a well-formed token signed by a hand Apple never published.
_SIGNING_KEY = rsa.generate_private_key(
    public_exponent=RSA_PUBLIC_EXPONENT,
    key_size=RSA_KEY_SIZE,
)
_FORGER_KEY = rsa.generate_private_key(
    public_exponent=RSA_PUBLIC_EXPONENT,
    key_size=RSA_KEY_SIZE,
)


def _epoch(offset: timedelta) -> int:
    """Return the UNIX timestamp ``offset`` away from now."""
    return int((datetime.now(UTC) + offset).timestamp())


def _claims(**overrides: object) -> dict[str, object]:
    """Build an Apple-shaped id_token claim set with per-test overrides.

    The string-valued ``email_verified`` and ``is_private_email`` are the
    defaults because that is what Apple actually sends; the boolean spellings
    are exercised by explicit overrides.
    """
    base: dict[str, object] = {
        "iss": APPLE_ISSUER,
        "aud": BUNDLE_ID,
        "sub": KNOWN_SUBJECT,
        "email": EXISTING_EMAIL,
        "email_verified": VERIFIED_TRUE_STRING,
        "is_private_email": VERIFIED_FALSE_STRING,
        "iat": _epoch(-JUST_ISSUED),
        "exp": _epoch(TOKEN_LIFETIME),
    }
    base.update(overrides)
    return base


def _sign_rs256(claims: dict[str, object], private_key: rsa.RSAPrivateKey) -> str:
    """Sign ``claims`` as an RS256 JWT carrying the module's ``kid`` header."""
    return jwt.encode(
        claims,
        private_key,
        algorithm=RS256_ALGORITHM,
        headers={"kid": TEST_KID},
    )


def _mint_token(**overrides: object) -> str:
    """Mint a legitimately signed Apple id_token."""
    return _sign_rs256(_claims(**overrides), _SIGNING_KEY)


def _mint_forged_token(**overrides: object) -> str:
    """Mint a well-formed id_token signed by a key Apple never published."""
    return _sign_rs256(_claims(**overrides), _FORGER_KEY)


def _mint_token_without(*dropped: str, **overrides: object) -> str:
    """Mint a legitimately signed token with ``dropped`` claims removed entirely."""
    claims = _claims(**overrides)
    for claim in dropped:
        claims.pop(claim, None)
    return _sign_rs256(claims, _SIGNING_KEY)


def _mint_google_token(**overrides: object) -> str:
    """Mint a Google-shaped id_token for the cross-provider linking test."""
    claims: dict[str, object] = {
        "iss": GOOGLE_ISSUER,
        "aud": GOOGLE_CLIENT_ID,
        "sub": GOOGLE_SUBJECT,
        "email": EXISTING_EMAIL,
        "email_verified": True,
        "iat": _epoch(-JUST_ISSUED),
        "exp": _epoch(TOKEN_LIFETIME),
    }
    claims.update(overrides)
    return _sign_rs256(claims, _SIGNING_KEY)


def _oauth_payload(
    id_token: str,
    license_key: str | None = None,
    full_name: str | None = None,
    timezone: str | None = None,
) -> dict[str, str]:
    """Build the request body; ``None`` arguments omit their field entirely."""
    payload = {"id_token": id_token}
    if license_key is not None:
        payload["license_key"] = license_key
    if full_name is not None:
        payload["full_name"] = full_name
    if timezone is not None:
        payload["timezone"] = timezone
    return payload


def _log_carries_marker(caplog: pytest.LogCaptureFixture, marker: str) -> bool:
    """Return True when ``marker`` appears in captured text or as a reason_code."""
    if marker in caplog.text:
        return True
    return any(getattr(record, "reason_code", None) == marker for record in caplog.records)


def _log_haystack(caplog: pytest.LogCaptureFixture) -> str:
    """Return every captured record's text, including the formatted extras."""
    return caplog.text + "".join(str(record.__dict__) for record in caplog.records)


def _fingerprint(response: Response) -> tuple[int, str | None, bytes]:
    """Return everything an unauthenticated observer can see about a rejection."""
    return (response.status_code, response.headers.get("content-type"), response.content)


def _license_result(email: str) -> GumroadLicenseResult:
    """Build a live, unreversed Gumroad verify answer for ``email``."""
    return GumroadLicenseResult(
        success=True,
        uses=LICENSE_USES,
        purchase=GumroadPurchase(
            email=email,
            product_id=ALLOWED_PRODUCT,
            sale_id=SALE_ID,
            refunded=False,
            chargebacked=False,
            disputed=False,
            dispute_won=False,
        ),
    )


@dataclass(frozen=True)
class _StubSigningKey:
    """What a JWKS client hands back for a token's ``kid``: a key carrier."""

    key: object


class _StubJWKClient:
    """Offline stand-in for ``PyJWKClient`` -- answers from the module keypair."""

    def __init__(self, key: object) -> None:
        """Hold the public key every lookup resolves to."""
        self._key = key
        self.lookups: list[str] = []

    def get_signing_key_from_jwt(self, token: str) -> _StubSigningKey:
        """Record the lookup and return the module's public signing key."""
        self.lookups.append(token)
        return _StubSigningKey(self._key)


class _LicenseVerifier:
    """Network-free stand-in for the outbound Gumroad license verify."""

    def __init__(self) -> None:
        """Start with no grants recorded."""
        self.calls: list[tuple[str, str]] = []
        self.results: dict[str, GumroadLicenseResult] = {}

    def grant(self, license_key: str, email: str) -> None:
        """Make ``license_key`` verify as a live purchase made by ``email``."""
        self.results[license_key] = _license_result(email)

    async def verify(
        self,
        product_id: str,
        license_key: str,
        **_kwargs: object,
    ) -> GumroadLicenseResult | None:
        """Answer for ``license_key``, or ``None`` when it was never granted."""
        self.calls.append((product_id, license_key))
        return self.results.get(license_key)


@pytest.fixture(autouse=True)
def offline_jwks(monkeypatch: pytest.MonkeyPatch) -> _StubJWKClient:
    """Replace Apple's JWKS client so no test in this module hits the network."""
    client = _StubJWKClient(_SIGNING_KEY.public_key())

    def _factory() -> _StubJWKClient:
        return client

    monkeypatch.setattr(JWKS_SEAM, _factory)
    return client


@pytest.fixture(autouse=True)
def apple_client_ids(monkeypatch: pytest.MonkeyPatch) -> str:
    """Configure the accepted Apple audiences for the module."""
    monkeypatch.setenv(APPLE_OAUTH_CLIENT_IDS_ENV_VAR, CONFIGURED_CLIENT_IDS)
    return CONFIGURED_CLIENT_IDS


@pytest.fixture
def offline_google(monkeypatch: pytest.MonkeyPatch) -> None:
    """Configure and stub the Google adapter for the cross-provider test."""
    client = _StubJWKClient(_SIGNING_KEY.public_key())

    def _factory() -> _StubJWKClient:
        return client

    monkeypatch.setattr(GOOGLE_JWKS_SEAM, _factory)
    monkeypatch.setenv(GOOGLE_OAUTH_CLIENT_IDS_ENV_VAR, GOOGLE_CLIENT_ID)


@pytest.fixture
def allowlisted_products(monkeypatch: pytest.MonkeyPatch) -> str:
    """Point the APTITUDE product allowlist at the test product id."""
    monkeypatch.setenv(PRODUCT_IDS_ENV_VAR, ALLOWLIST)
    return ALLOWLIST


@pytest.fixture
def license_verifier(
    monkeypatch: pytest.MonkeyPatch,
    allowlisted_products: str,  # noqa: ARG001 - side-effect: configures the allowlist
) -> _LicenseVerifier:
    """Stub the outbound Gumroad verify while leaving the real license gate in place."""
    verifier = _LicenseVerifier()
    monkeypatch.setattr(VERIFY_SEAM, verifier.verify)
    return verifier


def _user_id(user: User) -> int:
    """Return a committed user's primary key, failing loudly when absent."""
    if user.id is None:
        msg = "user id missing after commit"
        raise RuntimeError(msg)
    return user.id


async def _count_rows(session: AsyncSession, model: type[SQLModel]) -> int:
    """Return the number of ``model`` rows visible to ``session``."""
    result = await session.execute(select(func.count()).select_from(model))
    return int(result.scalar_one())


async def _seed_user(
    session: AsyncSession,
    email: str = EXISTING_EMAIL,
    display_name: str | None = None,
) -> User:
    """Insert a password-authenticated user and return the committed row."""
    user = User(
        email=email,
        password_hash=SEEDED_PASSWORD_HASH,
        timezone=SEEDED_TIMEZONE,
        display_name=display_name,
    )
    session.add(user)
    await session.commit()
    await session.refresh(user)
    return user


async def _seed_identity(
    session: AsyncSession,
    user_id: int,
    subject: str,
    provider: AuthProvider = AuthProvider.APPLE,
    email: str = EXISTING_EMAIL,
) -> AuthIdentity:
    """Insert a linked provider identity for ``user_id`` and return the committed row."""
    identity = AuthIdentity(
        user_id=user_id,
        provider=provider,
        subject=subject,
        email_at_link_time=email,
    )
    session.add(identity)
    await session.commit()
    await session.refresh(identity)
    return identity


async def _only_identity(session: AsyncSession) -> AuthIdentity:
    """Return the single AuthIdentity row, asserting there is exactly one."""
    identities = (await session.execute(select(AuthIdentity))).scalars().all()
    assert len(identities) == 1
    return identities[0]


async def _reload_user(session: AsyncSession, user_id: int) -> User:
    """Re-read ``user_id`` from the database, defeating any stale identity map."""
    user = await session.get(User, user_id)
    assert user is not None
    await session.refresh(user)
    return user


# ---------------------------------------------------------------------------
# A. Provider configuration
# ---------------------------------------------------------------------------


def test_apple_issuers_is_exactly_apples_identity_service() -> None:
    """Only Apple's own issuer may sign a token this route accepts."""
    assert APPLE_ISSUER in APPLE_ISSUERS
    assert len(APPLE_ISSUERS) == SOLE_APPLE_ISSUER_COUNT


def test_jwks_client_is_bounded_and_points_at_apple() -> None:
    """The JWKS client is Apple's, over TLS, with every cache and timeout bounded.

    PyJWT's 30-second default timeout is the dangerous one: a token naming a
    ``kid`` outside the cached set forces an immediate refetch, and that fetch
    occupies a worker in the same default thread pool bcrypt runs in, so
    unauthenticated junk tokens could park threads that logins need.
    """
    client = build_jwk_client()
    parsed = urlparse(client.uri)

    assert client.uri == APPLE_JWKS_URL
    assert parsed.scheme == "https"
    assert parsed.hostname == APPLE_HOST
    assert client.timeout == JWKS_TIMEOUT_SECONDS
    assert 0 < JWKS_TIMEOUT_SECONDS <= MAX_ACCEPTABLE_JWKS_TIMEOUT

    key_cache = getattr(client.get_signing_key, "cache_info", None)
    assert key_cache is not None
    assert 0 < key_cache().maxsize <= MAX_ACCEPTABLE_CACHED_KEYS

    assert client.jwk_set_cache is not None
    assert 0 < client.jwk_set_cache.lifespan <= MAX_ACCEPTABLE_JWKS_LIFESPAN


@pytest.mark.asyncio
@pytest.mark.parametrize("client_ids", [None, ""], ids=["unset", "blank"])
async def test_unconfigured_client_ids_reject_even_a_perfect_token(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    client_ids: str | None,
) -> None:
    """With no configured audience the verifier fails closed rather than open."""
    if client_ids is None:
        monkeypatch.delenv(APPLE_OAUTH_CLIENT_IDS_ENV_VAR, raising=False)
    else:
        monkeypatch.setenv(APPLE_OAUTH_CLIENT_IDS_ENV_VAR, client_ids)
    user = await _seed_user(db_session)
    await _seed_identity(db_session, _user_id(user), KNOWN_SUBJECT)

    response = await async_client.post(OAUTH_PATH, json=_oauth_payload(_mint_token()))

    assert response.status_code == HTTPStatus.UNAUTHORIZED
    assert response.json()["detail"] == DETAIL_INVALID_TOKEN
    assert await _count_rows(db_session, AuthIdentity) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "audience",
    [BUNDLE_ID, SERVICES_ID],
    ids=["ios-bundle-id", "services-id"],
)
async def test_either_configured_audience_is_accepted(
    async_client: AsyncClient,
    db_session: AsyncSession,
    audience: str,
) -> None:
    """The native app and the web Services id are both legitimate audiences."""
    user = await _seed_user(db_session)
    await _seed_identity(db_session, _user_id(user), KNOWN_SUBJECT)

    response = await async_client.post(
        OAUTH_PATH,
        json=_oauth_payload(_mint_token(aud=audience)),
    )

    assert response.status_code == HTTPStatus.OK
    assert response.json()["user_id"] == _user_id(user)


# ---------------------------------------------------------------------------
# B. Cryptographic verification
# ---------------------------------------------------------------------------

_UNVERIFIABLE_TOKENS = (
    pytest.param(_mint_forged_token(), id="signed-by-an-unrelated-key"),
    pytest.param(_mint_token(aud=OTHER_CLIENT_ID), id="audience-is-another-client"),
    pytest.param(_mint_token(iss=EVIL_ISSUER), id="issuer-is-not-apple"),
    pytest.param(
        _mint_token(iat=_epoch(-EXPIRED_ISSUED_AGO), exp=_epoch(-EXPIRED_EXPIRY_AGO)),
        id="expired",
    ),
    # A token carrying no ``exp`` never expires, so absence has to be rejected
    # outright rather than skipped the way an unasserted claim would be.
    pytest.param(_mint_token_without("exp"), id="valid-signature-no-expiry"),
)


@pytest.mark.asyncio
@pytest.mark.parametrize("id_token", _UNVERIFIABLE_TOKENS)
async def test_unverifiable_token_is_401_and_leaks_nothing(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
    id_token: str,
) -> None:
    """Every verification failure is the same 401, writes nothing, and logs no token."""
    caplog.set_level(logging.INFO)

    response = await async_client.post(OAUTH_PATH, json=_oauth_payload(id_token))

    assert response.status_code == HTTPStatus.UNAUTHORIZED
    assert response.json()["detail"] == DETAIL_INVALID_TOKEN
    assert "token" not in response.json()
    assert await _count_rows(db_session, User) == 0
    assert await _count_rows(db_session, AuthIdentity) == 0
    assert _log_carries_marker(caplog, REASON_INVALID_TOKEN)

    haystack = _log_haystack(caplog) + response.text
    assert id_token not in haystack
    for segment in id_token.split("."):
        assert segment not in haystack


@pytest.mark.asyncio
async def test_sixth_attempt_in_a_minute_is_rate_limited(async_client: AsyncClient) -> None:
    """The endpoint carries the login-strength 5/minute per-IP cap."""
    id_token = _mint_forged_token()

    for _ in range(OAUTH_RATE_LIMIT_PER_MINUTE):
        response = await async_client.post(OAUTH_PATH, json=_oauth_payload(id_token))
        assert response.status_code == HTTPStatus.UNAUTHORIZED

    throttled = await async_client.post(OAUTH_PATH, json=_oauth_payload(id_token))

    assert throttled.status_code == HTTPStatus.TOO_MANY_REQUESTS


# ---------------------------------------------------------------------------
# C. Sign-in by stored subject
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_known_apple_identity_logs_in_without_creating_a_row(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A stored (apple, sub) pair mints a JWT for its user and links nothing new."""
    caplog.set_level(logging.INFO)
    user = await _seed_user(db_session)
    await _seed_identity(db_session, _user_id(user), KNOWN_SUBJECT)

    response = await async_client.post(
        OAUTH_PATH,
        json=_oauth_payload(_mint_token(sub=KNOWN_SUBJECT)),
    )

    assert response.status_code == HTTPStatus.OK
    body = response.json()
    assert body["user_id"] == _user_id(user)
    assert body["timezone"] == SEEDED_TIMEZONE
    assert len(body["token"].split(".")) == JWT_SEGMENT_COUNT
    assert await _count_rows(db_session, AuthIdentity) == 1
    assert await _count_rows(db_session, User) == 1
    assert _log_carries_marker(caplog, REASON_LOGIN)


@pytest.mark.asyncio
async def test_repeat_signin_without_any_email_claim_resolves_by_subject(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Apple sends ``email`` only on the first authorization; later tokens have none.

    Keying the lookup on email rather than ``sub`` would work exactly once and
    then lock every returning user out of their own account.
    """
    user = await _seed_user(db_session)
    await _seed_identity(db_session, _user_id(user), KNOWN_SUBJECT)
    id_token = _mint_token_without("email", "email_verified", "is_private_email")

    response = await async_client.post(OAUTH_PATH, json=_oauth_payload(id_token))

    assert response.status_code == HTTPStatus.OK
    assert response.json()["user_id"] == _user_id(user)
    assert await _count_rows(db_session, AuthIdentity) == 1


# ---------------------------------------------------------------------------
# D. Apple's string-valued booleans
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "email_verified",
    [VERIFIED_TRUE_STRING, True],
    ids=["string-true", "boolean-true"],
)
@pytest.mark.parametrize(
    "is_private_email",
    [VERIFIED_TRUE_STRING, VERIFIED_FALSE_STRING],
    ids=["private-relay-flag-true", "private-relay-flag-false"],
)
async def test_string_true_email_verified_is_honoured(
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
    email_verified: object,
    is_private_email: str,
) -> None:
    """Apple's string ``"true"`` verifies the email exactly as a boolean would.

    ``is_private_email`` is orthogonal: it describes the address, not whether
    Apple vouches for it, so it must not change the outcome either way.
    """
    caplog.set_level(logging.INFO)
    user = await _seed_user(db_session)

    response = await async_client.post(
        OAUTH_PATH,
        json=_oauth_payload(
            _mint_token(
                sub=FRESH_SUBJECT,
                email=EXISTING_EMAIL,
                email_verified=email_verified,
                is_private_email=is_private_email,
            )
        ),
    )

    assert response.status_code == HTTPStatus.OK
    assert response.json()["user_id"] == _user_id(user)
    assert await _count_rows(db_session, User) == 1

    identity = await _only_identity(db_session)
    assert identity.provider == AuthProvider.APPLE
    assert identity.subject == FRESH_SUBJECT
    assert identity.user_id == _user_id(user)
    assert _log_carries_marker(caplog, REASON_LINKED)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "email_verified",
    [VERIFIED_FALSE_STRING, False],
    ids=["string-false", "boolean-false"],
)
async def test_unverified_email_never_creates_an_account(
    async_client: AsyncClient,
    db_session: AsyncSession,
    license_verifier: _LicenseVerifier,
    email_verified: object,
) -> None:
    """A false ``email_verified`` blocks creation even with a valid license in hand.

    The string ``"false"`` is the trap: it is truthy in Python, so a verifier
    that coerces with ``bool(...)`` would treat an address Apple explicitly
    refuses to vouch for as proven.
    """
    license_verifier.grant(VALID_LICENSE_KEY, NEW_EMAIL)

    response = await async_client.post(
        OAUTH_PATH,
        json=_oauth_payload(
            _mint_token(sub=UNVERIFIED_SUBJECT, email=NEW_EMAIL, email_verified=email_verified),
            license_key=VALID_LICENSE_KEY,
        ),
    )

    assert response.status_code == HTTPStatus.CONFLICT
    assert response.json()["detail"] == DETAIL_NEEDS_LICENSE
    assert "token" not in response.json()
    assert await _count_rows(db_session, User) == 0
    assert await _count_rows(db_session, AuthIdentity) == 0
    assert await _count_rows(db_session, Entitlement) == 0


# ---------------------------------------------------------------------------
# E. Account creation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_private_relay_email_with_a_license_creates_the_account(
    async_client: AsyncClient,
    db_session: AsyncSession,
    license_verifier: _LicenseVerifier,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A ``privaterelay.appleid.com`` address is a first-class account address.

    Apple's Hide My Email users never present anything else, so the relay
    address is stored verbatim and is the address the license must match.
    """
    caplog.set_level(logging.INFO)
    license_verifier.grant(RELAY_LICENSE_KEY, RELAY_EMAIL)

    response = await async_client.post(
        OAUTH_PATH,
        json=_oauth_payload(
            _mint_token(
                sub=RELAY_SUBJECT,
                email=RELAY_EMAIL,
                is_private_email=VERIFIED_TRUE_STRING,
            ),
            license_key=RELAY_LICENSE_KEY,
            timezone=SIGNUP_TIMEZONE,
        ),
    )

    assert response.status_code == HTTPStatus.OK
    body = response.json()
    assert body["timezone"] == SIGNUP_TIMEZONE
    assert len(body["token"].split(".")) == JWT_SEGMENT_COUNT

    users = (await db_session.execute(select(User))).scalars().all()
    assert len(users) == 1
    assert users[0].email == RELAY_EMAIL
    assert users[0].id == body["user_id"]

    entitlements = (await db_session.execute(select(Entitlement))).scalars().all()
    assert len(entitlements) == 1
    assert entitlements[0].kind == COURSE_ACCESS_KIND
    assert entitlements[0].user_id == body["user_id"]
    assert entitlements[0].revoked_at is None

    identity = await _only_identity(db_session)
    assert identity.provider == AuthProvider.APPLE
    assert identity.subject == RELAY_SUBJECT
    assert identity.user_id == body["user_id"]
    assert identity.email_at_link_time == RELAY_EMAIL
    assert _log_carries_marker(caplog, REASON_SIGNUP)


# ---------------------------------------------------------------------------
# F. The display name, which only ever arrives once
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("submitted", "stored"),
    [(FULL_NAME, FULL_NAME), (PADDED_FULL_NAME, FULL_NAME)],
    ids=["exact", "padded"],
)
async def test_full_name_becomes_the_display_name_at_creation(
    async_client: AsyncClient,
    db_session: AsyncSession,
    license_verifier: _LicenseVerifier,
    submitted: str,
    stored: str,
) -> None:
    """Apple never puts a name in the token, so the body's ``full_name`` is it."""
    license_verifier.grant(VALID_LICENSE_KEY, NEW_EMAIL)

    response = await async_client.post(
        OAUTH_PATH,
        json=_oauth_payload(
            _mint_token(sub=NEW_SUBJECT, email=NEW_EMAIL),
            license_key=VALID_LICENSE_KEY,
            full_name=submitted,
        ),
    )

    assert response.status_code == HTTPStatus.OK
    user = await _reload_user(db_session, response.json()["user_id"])
    assert user.display_name == stored


@pytest.mark.asyncio
@pytest.mark.parametrize("full_name", ["", "   ", "\t\n"], ids=["empty", "spaces", "whitespace"])
async def test_blank_full_name_stores_no_display_name(
    async_client: AsyncClient,
    db_session: AsyncSession,
    license_verifier: _LicenseVerifier,
    full_name: str,
) -> None:
    """A blank name is an absent name, not a blank string rendered in the UI."""
    license_verifier.grant(VALID_LICENSE_KEY, NEW_EMAIL)

    response = await async_client.post(
        OAUTH_PATH,
        json=_oauth_payload(
            _mint_token(sub=NEW_SUBJECT, email=NEW_EMAIL),
            license_key=VALID_LICENSE_KEY,
            full_name=full_name,
        ),
    )

    assert response.status_code == HTTPStatus.OK
    user = await _reload_user(db_session, response.json()["user_id"])
    assert user.display_name is None


@pytest.mark.asyncio
async def test_full_name_past_the_stored_ceiling_is_refused_by_the_schema(
    async_client: AsyncClient,
    db_session: AsyncSession,
    license_verifier: _LicenseVerifier,
) -> None:
    """An over-long name is a 422 at the boundary, never a truncated column write.

    The bound has to live on the request model rather than only on the column:
    a database left to enforce it either raises a 500 mid-transaction or, on a
    backend that truncates silently, stores a name the user never chose.
    """
    license_verifier.grant(VALID_LICENSE_KEY, NEW_EMAIL)

    response = await async_client.post(
        OAUTH_PATH,
        json=_oauth_payload(
            _mint_token(sub=NEW_SUBJECT, email=NEW_EMAIL),
            license_key=VALID_LICENSE_KEY,
            full_name=OVERLONG_FULL_NAME,
        ),
    )

    assert response.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert await _count_rows(db_session, User) == 0
    assert await _count_rows(db_session, AuthIdentity) == 0


@pytest.mark.asyncio
async def test_a_later_signin_can_never_rename_the_account(
    async_client: AsyncClient,
    db_session: AsyncSession,
    license_verifier: _LicenseVerifier,
) -> None:
    """The name is write-once: Apple only ever sends it on the first authorization.

    A later request carrying a different ``full_name`` is either a stale client
    or an attacker with a valid token; either way the stored name stands, so
    the sign-in route can never be used to rename somebody's account.
    """
    license_verifier.grant(VALID_LICENSE_KEY, NEW_EMAIL)
    created = await async_client.post(
        OAUTH_PATH,
        json=_oauth_payload(
            _mint_token(sub=NEW_SUBJECT, email=NEW_EMAIL),
            license_key=VALID_LICENSE_KEY,
            full_name=FULL_NAME,
        ),
    )
    assert created.status_code == HTTPStatus.OK
    user_id = created.json()["user_id"]

    silent = await async_client.post(
        OAUTH_PATH,
        json=_oauth_payload(_mint_token_without("email", "email_verified", sub=NEW_SUBJECT)),
    )

    assert silent.status_code == HTTPStatus.OK
    assert silent.json()["user_id"] == user_id
    assert (await _reload_user(db_session, user_id)).display_name == FULL_NAME

    renaming = await async_client.post(
        OAUTH_PATH,
        json=_oauth_payload(
            _mint_token_without("email", "email_verified", sub=NEW_SUBJECT),
            full_name=IMPOSTOR_NAME,
        ),
    )

    assert renaming.status_code == HTTPStatus.OK
    assert renaming.json()["user_id"] == user_id
    assert (await _reload_user(db_session, user_id)).display_name == FULL_NAME


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "seeded_name",
    [None, SEEDED_DISPLAY_NAME],
    ids=["no-stored-name", "stored-name"],
)
async def test_full_name_is_ignored_on_the_email_link_rung(
    async_client: AsyncClient,
    db_session: AsyncSession,
    seeded_name: str | None,
) -> None:
    """Linking Apple onto an existing account may not relabel that account.

    The account already exists and its name (or deliberate lack of one) belongs
    to its owner; ``full_name`` is only ever consulted by the rung that creates
    the row.
    """
    user = await _seed_user(db_session, display_name=seeded_name)

    response = await async_client.post(
        OAUTH_PATH,
        json=_oauth_payload(
            _mint_token(sub=FRESH_SUBJECT, email=EXISTING_EMAIL),
            full_name=IMPOSTOR_NAME,
        ),
    )

    assert response.status_code == HTTPStatus.OK
    assert response.json()["user_id"] == _user_id(user)
    assert (await _only_identity(db_session)).subject == FRESH_SUBJECT
    assert (await _reload_user(db_session, _user_id(user))).display_name == seeded_name


# ---------------------------------------------------------------------------
# G. Anti-enumeration
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_needs_license_refusals_are_byte_identical(
    async_client: AsyncClient,
    db_session: AsyncSession,
    license_verifier: _LicenseVerifier,
) -> None:
    """A brand-new email with no license and an unverified one look the same.

    Any difference between the two -- one byte of body, one header, one status
    -- would tell an unauthenticated caller which addresses Apple has verified
    and which accounts already exist.
    """
    license_verifier.grant(VALID_LICENSE_KEY, SECOND_NEW_EMAIL)

    no_license = await async_client.post(
        OAUTH_PATH,
        json=_oauth_payload(_mint_token(sub=NO_LICENSE_SUBJECT, email=NEW_EMAIL)),
    )
    unverified = await async_client.post(
        OAUTH_PATH,
        json=_oauth_payload(
            _mint_token(
                sub=UNVERIFIED_SUBJECT,
                email=SECOND_NEW_EMAIL,
                email_verified=VERIFIED_FALSE_STRING,
            ),
            license_key=VALID_LICENSE_KEY,
        ),
    )

    fingerprints = [_fingerprint(no_license), _fingerprint(unverified)]
    assert len(fingerprints) == BYTE_IDENTICAL_REJECTIONS
    assert all(status == HTTPStatus.CONFLICT for status, _, _ in fingerprints)
    assert all(DETAIL_NEEDS_LICENSE.encode() in body for _, _, body in fingerprints)
    assert len(set(fingerprints)) == 1
    assert await _count_rows(db_session, User) == 0
    assert await _count_rows(db_session, AuthIdentity) == 0


# ---------------------------------------------------------------------------
# H. Two providers, one account
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.usefixtures("offline_google")
async def test_apple_links_alongside_an_existing_google_identity(
    async_client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    """One account may carry both links, and either one signs into it.

    The unique constraint is on ``(provider, subject)``, not on ``user_id``, so
    a second provider is a second row -- never a second account.
    """
    user = await _seed_user(db_session)
    await _seed_identity(
        db_session,
        _user_id(user),
        GOOGLE_SUBJECT,
        provider=AuthProvider.GOOGLE,
    )

    linked = await async_client.post(
        OAUTH_PATH,
        json=_oauth_payload(_mint_token(sub=LINKED_SUBJECT, email=EXISTING_EMAIL)),
    )

    assert linked.status_code == HTTPStatus.OK
    assert linked.json()["user_id"] == _user_id(user)

    identities = (await db_session.execute(select(AuthIdentity))).scalars().all()
    assert len(identities) == DUAL_IDENTITY_COUNT
    assert {identity.provider for identity in identities} == {
        AuthProvider.GOOGLE,
        AuthProvider.APPLE,
    }
    assert {identity.user_id for identity in identities} == {_user_id(user)}
    assert await _count_rows(db_session, User) == 1

    via_google = await async_client.post(
        GOOGLE_OAUTH_PATH,
        json=_oauth_payload(_mint_google_token()),
    )
    via_apple = await async_client.post(
        OAUTH_PATH,
        json=_oauth_payload(_mint_token_without("email", "email_verified", sub=LINKED_SUBJECT)),
    )

    assert via_google.status_code == HTTPStatus.OK
    assert via_apple.status_code == HTTPStatus.OK
    assert via_google.json()["user_id"] == _user_id(user)
    assert via_apple.json()["user_id"] == _user_id(user)
    assert await _count_rows(db_session, AuthIdentity) == DUAL_IDENTITY_COUNT
