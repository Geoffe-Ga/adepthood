"""The agent-token signing keys and the key set the vault verifies with (#3533).

``OAUTH_SIGNING_KEYS`` has the operational shape of ``JOURNAL_ENCRYPTION_KEYS``:
a list, newest first, where the first key signs and every key is published, so
rotation is add-new, redeploy, drop-old. These tests pin that shape, the
refusals of anything that is not a P-256 private key, and the RFC 7638 key ids
the vault selects a key by.
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
from collections.abc import Iterator

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa

from services import oauth_signing_keys
from services.journal_encryption import PRODUCTION_SIGNAL_ENV_VARS
from services.oauth_signing_keys import (
    SIGNING_ALGORITHM,
    SIGNING_KEYS_ENV_VAR,
    OAuthSigningKeyError,
    current_signing_key,
    ephemeral_key_allowed,
    jwk_thumbprint,
    published_key_set,
    signing_keys,
)
from tests.helpers.oauth import generate_signing_key, pem_of

# RFC 7638 section 3.1's worked example is RSA; this is the same computation on
# a P-256 key, written out longhand so the test does not share code with the
# implementation it checks.
_P256_COORDINATE_BYTES = 32

# A well-formed PEM frame around a body that is no key. Assembled at run time so
# no literal in this file reads as a committed private key.
_PEM_LABEL = "PRIVATE KEY"


@pytest.fixture(autouse=True)
def _fresh_cache() -> Iterator[None]:
    """Every test reads the environment it sets, and leaves no keys behind."""
    oauth_signing_keys.reset_cache()
    yield
    oauth_signing_keys.reset_cache()


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _expected_thumbprint(key: ec.EllipticCurvePrivateKey) -> str:
    numbers = key.public_key().public_numbers()
    members = {
        "crv": "P-256",
        "kty": "EC",
        "x": _b64url(numbers.x.to_bytes(_P256_COORDINATE_BYTES, "big")),
        "y": _b64url(numbers.y.to_bytes(_P256_COORDINATE_BYTES, "big")),
    }
    canonical = json.dumps(members, separators=(",", ":"), sort_keys=True).encode()
    return _b64url(hashlib.sha256(canonical).digest())


def _clear_environment_signals(monkeypatch: pytest.MonkeyPatch) -> None:
    """No inherited shell value decides where this process thinks it runs."""
    for name in PRODUCTION_SIGNAL_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.delenv(SIGNING_KEYS_ENV_VAR, raising=False)


@pytest.mark.parametrize(
    ("variable", "value"),
    [
        pytest.param("ENV", "production", id="production"),
        pytest.param("RAILWAY_ENVIRONMENT_NAME", "staging", id="hosted-staging"),
        pytest.param("RAILWAY_PROJECT_ID", "p-1", id="hosted-unnamed"),
    ],
)
def test_where_a_key_is_required_unset_means_nothing_to_sign_with(
    monkeypatch: pytest.MonkeyPatch, variable: str, value: str
) -> None:
    """Production and every hosted environment: an honest "not configured", never a key."""
    _clear_environment_signals(monkeypatch)
    monkeypatch.setenv(variable, value)
    assert not ephemeral_key_allowed()
    assert signing_keys() == ()
    assert current_signing_key() is None
    assert published_key_set() == {"keys": []}


def test_a_laptop_or_ci_job_gets_one_ephemeral_key_and_is_told(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Off-platform and outside production, an unset variable is one process-local key."""
    _clear_environment_signals(monkeypatch)
    assert ephemeral_key_allowed()
    with caplog.at_level(logging.WARNING, logger=oauth_signing_keys.__name__):
        first = current_signing_key()
        again = current_signing_key()
    assert first is not None
    assert again == first
    assert [entry["kid"] for entry in published_key_set()["keys"]] == [first.kid]
    events = [
        record for record in caplog.records if record.message == "oauth_signing_key_ephemeral"
    ]
    assert len(events) == 1
    assert "BEGIN" not in str(vars(events[0]))
    oauth_signing_keys.reset_cache()
    assert current_signing_key() != first


def test_a_configured_key_is_used_even_where_an_ephemeral_one_would_be_allowed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The fallback answers only an unset variable; configuration always wins."""
    _clear_environment_signals(monkeypatch)
    key = generate_signing_key()
    monkeypatch.setenv(SIGNING_KEYS_ENV_VAR, pem_of(key))
    current = current_signing_key()
    assert current is not None
    assert current.kid == _expected_thumbprint(key)


def test_the_first_key_signs_and_every_key_is_published(monkeypatch: pytest.MonkeyPatch) -> None:
    """Newest first: the head of the list signs, the whole list verifies."""
    newest, previous = generate_signing_key(), generate_signing_key()
    monkeypatch.setenv(SIGNING_KEYS_ENV_VAR, f"{pem_of(newest)},{pem_of(previous)}")
    current = current_signing_key()
    assert current is not None
    assert current.kid == _expected_thumbprint(newest)
    published = published_key_set()["keys"]
    assert [entry["kid"] for entry in published] == [
        _expected_thumbprint(newest),
        _expected_thumbprint(previous),
    ]


def test_a_published_key_is_public_and_names_its_algorithm(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The vault requires the JWK's ``alg`` to equal the token header's; ``d`` never leaves."""
    key = generate_signing_key()
    monkeypatch.setenv(SIGNING_KEYS_ENV_VAR, pem_of(key))
    (entry,) = published_key_set()["keys"]
    numbers = key.public_key().public_numbers()
    assert entry == {
        "kty": "EC",
        "crv": "P-256",
        "x": _b64url(numbers.x.to_bytes(_P256_COORDINATE_BYTES, "big")),
        "y": _b64url(numbers.y.to_bytes(_P256_COORDINATE_BYTES, "big")),
        "kid": _expected_thumbprint(key),
        "alg": SIGNING_ALGORITHM,
        "use": "sig",
    }
    assert SIGNING_ALGORITHM == "ES256"


def test_the_key_id_is_the_rfc_7638_thumbprint() -> None:
    """Derived from the public key, so it cannot drift from the key it names."""
    key = generate_signing_key()
    assert jwk_thumbprint(key.public_key()) == _expected_thumbprint(key)


def test_escaped_newlines_are_read_as_newlines(monkeypatch: pytest.MonkeyPatch) -> None:
    r"""A platform that stores one-line variables gets ``\n`` and must still work."""
    key = generate_signing_key()
    monkeypatch.setenv(SIGNING_KEYS_ENV_VAR, pem_of(key).replace("\n", "\\n"))
    current = current_signing_key()
    assert current is not None
    assert current.kid == _expected_thumbprint(key)


def test_newline_separated_keys_are_a_list_too(monkeypatch: pytest.MonkeyPatch) -> None:
    """A comma or a blank line between keys: both read as two keys."""
    first, second = generate_signing_key(), generate_signing_key()
    monkeypatch.setenv(SIGNING_KEYS_ENV_VAR, f"{pem_of(first)}\n{pem_of(second)}")
    assert [key.kid for key in signing_keys()] == [
        _expected_thumbprint(first),
        _expected_thumbprint(second),
    ]


def _rsa_pem() -> str:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()


def _p384_pem() -> str:
    return pem_of(ec.generate_private_key(ec.SECP384R1()))


@pytest.mark.parametrize(
    "configured",
    [
        pytest.param("not a key at all", id="garbage"),
        pytest.param("BAD_PEM", id="bad-pem"),
        pytest.param("RSA", id="rsa"),
        pytest.param("P384", id="p-384"),
        pytest.param("PUBLIC", id="public-only"),
        pytest.param("DUPLICATE", id="the-same-key-twice"),
        pytest.param("TRAILER", id="garbage-after-a-key"),
    ],
)
def test_anything_but_distinct_p256_private_keys_is_refused(
    monkeypatch: pytest.MonkeyPatch, configured: str
) -> None:
    """A configured-but-wrong key fails loudly, and the message carries no key material."""
    key = generate_signing_key()
    public_pem = (
        key.public_key()
        .public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
        .decode()
    )
    value = {
        "RSA": _rsa_pem(),
        "P384": _p384_pem(),
        "PUBLIC": public_pem,
        "DUPLICATE": f"{pem_of(key)},{pem_of(key)}",
        "TRAILER": f"{pem_of(key)},leftover",
        "BAD_PEM": f"-----BEGIN {_PEM_LABEL}-----\nAAAA\n-----END {_PEM_LABEL}-----",
    }.get(configured, configured)
    monkeypatch.setenv(SIGNING_KEYS_ENV_VAR, value)
    with pytest.raises(OAuthSigningKeyError) as raised:
        signing_keys()
    message = str(raised.value)
    assert SIGNING_KEYS_ENV_VAR in message
    assert "BEGIN" not in message
    assert raised.value.__cause__ is None
    assert raised.value.__context__ is None or raised.value.__suppress_context__


def test_a_signing_key_does_not_show_its_private_half_in_a_repr(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A key that reaches a log line or a traceback shows its id and nothing else."""
    key = generate_signing_key()
    monkeypatch.setenv(SIGNING_KEYS_ENV_VAR, pem_of(key))
    current = current_signing_key()
    assert current is not None
    assert repr(current) == f"SigningKey(kid={current.kid!r})"


def test_the_keys_are_read_once_per_process(monkeypatch: pytest.MonkeyPatch) -> None:
    """Like the journal keys, rotation is a deploy: a changed variable needs a restart."""
    first = generate_signing_key()
    monkeypatch.setenv(SIGNING_KEYS_ENV_VAR, pem_of(first))
    before = current_signing_key()
    monkeypatch.setenv(SIGNING_KEYS_ENV_VAR, pem_of(generate_signing_key()))
    assert current_signing_key() == before
    oauth_signing_keys.reset_cache()
    assert current_signing_key() != before
