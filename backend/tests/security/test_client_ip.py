"""Trusted-proxy client-IP resolution: one answer for throttles and audit rows.

``X-Forwarded-For`` is attacker-controlled unless the socket peer is a proxy
we operate, so honouring it unconditionally lets a license brute-forcer mint
a fresh throttle bucket per request and write any address it likes into the
audit trail.  The resolver these tests pin ignores the header entirely unless
the peer sits inside ``TRUSTED_PROXY_CIDRS``, and then walks the chain from
the right so a client-prepended entry cannot win.

The integration cases fake the ASGI socket peer through ``ASGITransport`` and
assert that the slowapi limiter and the invalid-license throttle agree on the
key the resolver produces.  A further group reaches past the application
entirely and pins the runtime image's uvicorn flags -- both as tokens in the
Dockerfile CMD and as the ASGI stack uvicorn actually builds from them -- so
that no server-level layer can rewrite the socket peer or the request scheme
before this module runs.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from http import HTTPStatus
from pathlib import Path
from typing import TYPE_CHECKING

import pytest
from annotated_types import MaxLen
from httpx import ASGITransport, AsyncClient
from starlette.requests import Request
from uvicorn.config import Config
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from client_ip import TRUSTED_PROXIES_ENV_VAR, peer_is_trusted_proxy, resolve_client_ip
from database import get_session
from main import app
from models.password_reset_token import PasswordResetToken
from rate_limit import INVALID_LICENSE_MAX_PER_HOUR

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from httpx import Response
    from sqlalchemy.ext.asyncio import AsyncSession

# Documentation-range addresses (RFC 5737) so no test can be mistaken for a
# real network, plus one RFC 1918 block for the CIDR cases.
_TRUSTED_PROXY_NET = "192.0.2.0/24"
_PROXY_PEER = "192.0.2.10"
_SECOND_PROXY = "192.0.2.11"
_THIRD_PROXY = "192.0.2.12"
_UNTRUSTED_PEER = "198.51.100.7"
_CLIENT_IP = "203.0.113.5"
_OTHER_CLIENT_IP = "203.0.113.9"
_PRIVATE_NET = "10.0.0.0/8"
_PRIVATE_PEER = "10.1.2.3"
_TRUSTED_IPV6_NET = "2001:db8::/32"
_IPV6_PROXY_PEER = "2001:db8::1"
_IPV6_CLIENT = "fd00::42"
# A dual-stack listener reports an IPv4 connection in this form, and any caller
# can write it into the header, so both sides must fold back to the IPv4 address.
_MAPPED_PREFIX = "::ffff:"
_MAPPED_CLIENT_IP = f"{_MAPPED_PREFIX}{_CLIENT_IP}"
_MAPPED_PROXY_PEER = f"{_MAPPED_PREFIX}{_PROXY_PEER}"
_MALFORMED_HOP = "not-an-ip"
_MALFORMED_CONFIG_ENTRY = "300.1.2.3/8"
_PEER_PORT = 51_234

# A config value whose every entry is unparseable leaves no networks at all,
# which must read exactly like an unset variable rather than like "trust all".
_ALL_GARBAGE_CONFIG = "garbage,also-garbage"

# The widest possible operator typo: it parses cleanly, so every hop in any
# chain -- including the client's own address -- counts as one of our proxies.
_CATCH_ALL_NET = "0.0.0.0/0"

# The answer for any peer we cannot turn into an IP literal.
_UNKNOWN_CLIENT = "unknown"

# Long enough to overflow every audit column that stores a resolved address.
_OVERLONG_HOST_LENGTH = 200
_OVERLONG_PEER_HOST = "A" * _OVERLONG_HOST_LENGTH
# ``ipaddress`` accepts an arbitrarily long IPv6 zone id, so a hop can parse
# as a valid address and still be far too wide for the audit column.
_LONG_ZONE_ID = "z" * _OVERLONG_HOST_LENGTH
_SCOPED_IPV6_HOP = f"fe80::1%{_LONG_ZONE_ID}"

_AUDIT_IP_COLUMN = "requested_ip"


def _audit_ip_max_length() -> int:
    """Return the declared width of the narrowest column a resolved IP is stored in."""
    constraints = PasswordResetToken.model_fields[_AUDIT_IP_COLUMN].metadata
    declared = [item.max_length for item in constraints if isinstance(item, MaxLen)]
    assert len(declared) == 1
    return declared[0]


# Postgres raises DataError on an over-wide VARCHAR, so anything the resolver
# returns must fit the audit column or the reset endpoint 500s.
_AUDIT_IP_MAX_LENGTH = _audit_ip_max_length()

_DOCKERFILE = Path(__file__).resolve().parents[2] / "Dockerfile"
_CMD_DIRECTIVE = "CMD "
_WILDCARD_ALLOW_IPS = "--forwarded-allow-ips=*"
_PROXY_HEADERS_FLAG = "--proxy-headers"
_FORWARDED_ALLOW_IPS_FLAG = "--forwarded-allow-ips"
# Uvicorn spells the switch as the pair ``--proxy-headers/--no-proxy-headers``,
# and the off form contains the on form as a substring, so the CMD has to be
# compared token by token rather than searched for text.
_NO_PROXY_HEADERS_FLAG = "--no-proxy-headers"
_FLAG_VALUE_SEPARATOR = "="
_CMD_JSON_PUNCTUATION = '[],"'

# The import string the CMD hands uvicorn, resolved through the same
# ``backend/src`` sys.path entry the suite itself runs on.
_APP_IMPORT_STRING = "main:app"
# Uvicorn's own fallback trust set when no allowlist is given, and the
# environment variable that silently replaces it.
_UVICORN_DEFAULT_TRUSTED_PEER = "127.0.0.1"
_FORWARDED_ALLOW_IPS_ENV_VAR = "FORWARDED_ALLOW_IPS"
_TRUST_EVERY_PEER = "*"

_RESET_PATH = "/auth/password-reset/request"
_RESET_REQUESTS_PER_HOUR = 3
_UNREGISTERED_EMAIL = "nobody@example.com"

_SIGNUP_PATH = "/auth/signup"
_SIGNUP_PASSWORD = "securepassword123"  # pragma: allowlist secret
_LICENSE_KEY = "ABCD1234-EF56-7890-TEST"  # pragma: allowlist secret
_PRODUCT_IDS_ENV_VAR = "GUMROAD_APTITUDE_PRODUCT_IDS"
_ALLOWLISTED_PRODUCT = "prod_alpha"
_VERIFY_SEAM = "domain.entitlements.verify_license"
_DETAIL_INVALID_LICENSE = "invalid_license"
_DETAIL_THROTTLED = "too_many_license_attempts"
_SPOOFED_IP_PREFIX = "203.0.113."


def _make_request_with_lines(peer: tuple[str, int] | None, forwarded: list[str]) -> Request:
    """Build a bare ASGI request carrying one forwarded field line per entry.

    HAProxy's ``option forwardfor`` appends a separate ``X-Forwarded-For`` line
    when the request already has one, so a real chain can arrive split across
    several lines with the proxy-authored value last.
    """
    headers = [(b"x-forwarded-for", line.encode()) for line in forwarded]
    return Request({"type": "http", "headers": headers, "client": peer})


def _make_request(peer: tuple[str, int] | None, forwarded: str | None = None) -> Request:
    """Build a bare ASGI request with the given socket peer and forwarded header."""
    return _make_request_with_lines(peer, [] if forwarded is None else [forwarded])


def test_untrusted_peer_ignores_forwarded_header(monkeypatch: pytest.MonkeyPatch) -> None:
    """A peer outside the trusted set keys on its own address, header or not."""
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _TRUSTED_PROXY_NET)

    resolved = resolve_client_ip(_make_request((_UNTRUSTED_PEER, _PEER_PORT), _CLIENT_IP))

    assert resolved == _UNTRUSTED_PEER


def test_trusted_proxy_peer_returns_forwarded_client(monkeypatch: pytest.MonkeyPatch) -> None:
    """Behind a configured proxy the single forwarded entry is the client."""
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _TRUSTED_PROXY_NET)

    resolved = resolve_client_ip(_make_request((_PROXY_PEER, _PEER_PORT), _CLIENT_IP))

    assert resolved == _CLIENT_IP


def test_rightmost_untrusted_hop_wins_over_client_prepended_entry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Chained proxies resolve right to left, so a prepended entry never wins."""
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _TRUSTED_PROXY_NET)
    chain = f"{_CLIENT_IP}, {_UNTRUSTED_PEER}, {_SECOND_PROXY}"

    resolved = resolve_client_ip(_make_request((_PROXY_PEER, _PEER_PORT), chain))

    assert resolved == _UNTRUSTED_PEER
    assert resolved != _CLIENT_IP


@pytest.mark.parametrize("peer_host", [_PROXY_PEER, _UNTRUSTED_PEER])
def test_missing_forwarded_header_returns_socket_peer(
    monkeypatch: pytest.MonkeyPatch,
    peer_host: str,
) -> None:
    """With no header the socket peer answers for trusted and untrusted peers alike."""
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _TRUSTED_PROXY_NET)

    resolved = resolve_client_ip(_make_request((peer_host, _PEER_PORT)))

    assert resolved == peer_host


@pytest.mark.parametrize("configured", [None, "", "   ", _ALL_GARBAGE_CONFIG])
def test_unconfigured_trust_ignores_forwarded_header(
    monkeypatch: pytest.MonkeyPatch,
    configured: str | None,
) -> None:
    """Config that names no parseable network trusts nobody, header or not."""
    if configured is None:
        monkeypatch.delenv(TRUSTED_PROXIES_ENV_VAR, raising=False)
    else:
        monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, configured)

    resolved = resolve_client_ip(_make_request((_PROXY_PEER, _PEER_PORT), _CLIENT_IP))

    assert resolved == _PROXY_PEER


def test_cidr_config_entry_trusts_every_member_peer(monkeypatch: pytest.MonkeyPatch) -> None:
    """A CIDR entry grants trust to any peer inside the block."""
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _PRIVATE_NET)

    resolved = resolve_client_ip(_make_request((_PRIVATE_PEER, _PEER_PORT), _CLIENT_IP))

    assert resolved == _CLIENT_IP


def test_bare_ip_config_entry_trusts_only_that_address(monkeypatch: pytest.MonkeyPatch) -> None:
    """A bare address is a single-host network: its neighbour gets no trust."""
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _PROXY_PEER)

    trusted = resolve_client_ip(_make_request((_PROXY_PEER, _PEER_PORT), _CLIENT_IP))
    neighbour = resolve_client_ip(_make_request((_SECOND_PROXY, _PEER_PORT), _CLIENT_IP))

    assert trusted == _CLIENT_IP
    assert neighbour == _SECOND_PROXY


def test_malformed_config_entry_is_dropped_and_grants_no_trust(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An unparseable entry narrows trust to its valid siblings instead of widening it."""
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, f"{_MALFORMED_CONFIG_ENTRY},{_PROXY_PEER}")

    valid_sibling = resolve_client_ip(_make_request((_PROXY_PEER, _PEER_PORT), _CLIENT_IP))
    stranger = resolve_client_ip(_make_request((_UNTRUSTED_PEER, _PEER_PORT), _CLIENT_IP))

    assert valid_sibling == _CLIENT_IP
    assert stranger == _UNTRUSTED_PEER


def test_all_forwarded_entries_trusted_falls_back_to_socket_peer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A chain of nothing but our own proxies yields no client hop at all.

    Returning the left-most entry here reinstates the vulnerability the whole
    module exists to close: the left-most entry is the one a client can author,
    and a config that happens to cover the caller's own range turns every
    request into a self-declared address.  When every hop is a proxy we operate
    the request originated inside our infrastructure, so the socket peer is the
    correct key and nothing is lost by ignoring the chain.
    """
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _TRUSTED_PROXY_NET)
    chain = f"{_SECOND_PROXY}, {_THIRD_PROXY}"

    resolved = resolve_client_ip(_make_request((_PROXY_PEER, _PEER_PORT), chain))

    assert resolved == _PROXY_PEER


def test_catch_all_trusted_range_never_honours_a_forwarded_entry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An over-broad config must fail closed onto the peer, not open onto the header.

    ``0.0.0.0/0`` parses cleanly, so every hop reads as trusted and the chain
    yields no client hop; the address the caller wrote must not win by default.
    """
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _CATCH_ALL_NET)

    resolved = resolve_client_ip(_make_request((_UNTRUSTED_PEER, _PEER_PORT), _CLIENT_IP))

    assert resolved == _UNTRUSTED_PEER
    assert resolved != _CLIENT_IP


def test_forwarded_chain_split_across_header_lines_reads_the_last_line(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Every forwarded field line counts, not just the first one the client sent.

    Under a proxy that appends its own line instead of merging (HAProxy), reading
    only the first line hands the attacker authorship of the entire chain.
    """
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _TRUSTED_PROXY_NET)

    resolved = resolve_client_ip(
        _make_request_with_lines((_PROXY_PEER, _PEER_PORT), [_CLIENT_IP, _UNTRUSTED_PEER])
    )

    assert resolved == _UNTRUSTED_PEER
    assert resolved != _CLIENT_IP


@pytest.mark.parametrize("peer_host", [_MALFORMED_HOP, _OVERLONG_PEER_HOST])
def test_socket_peer_that_is_not_an_ip_literal_is_unknown(
    monkeypatch: pytest.MonkeyPatch,
    peer_host: str,
) -> None:
    """The peer is validated like a hop, so junk never reaches a key or an audit row."""
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _TRUSTED_PROXY_NET)

    resolved = resolve_client_ip(_make_request((peer_host, _PEER_PORT)))

    assert resolved == _UNKNOWN_CLIENT


def test_resolved_address_fits_the_audit_column(monkeypatch: pytest.MonkeyPatch) -> None:
    """A hop with a huge IPv6 zone id parses, so only a width check keeps it out.

    An over-wide value is accepted by SQLite and rejected by Postgres, which
    turns the password-reset request endpoint into an unauthenticated 500.
    """
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _TRUSTED_PROXY_NET)

    resolved = resolve_client_ip(_make_request((_PROXY_PEER, _PEER_PORT), _SCOPED_IPV6_HOP))

    assert len(resolved) <= _AUDIT_IP_MAX_LENGTH
    assert _LONG_ZONE_ID not in resolved


def _runtime_cmd() -> str:
    """Return the runtime image's CMD line from the backend Dockerfile."""
    lines = _DOCKERFILE.read_text().splitlines()
    commands = [line for line in lines if line.startswith(_CMD_DIRECTIVE)]
    assert len(commands) == 1, "expected exactly one CMD directive in backend/Dockerfile"
    return commands[0]


def test_runtime_image_never_trusts_every_forwarding_peer() -> None:
    """The server's own proxy trust set must not be a wildcard.

    ``--forwarded-allow-ips=*`` makes uvicorn's ProxyHeadersMiddleware trust
    every peer and overwrite ``scope["client"]`` with the *left-most*
    ``X-Forwarded-For`` entry -- the one the caller chose.  Every control that
    reads the socket peer, including this module's fallback, is then keyed on
    an attacker-supplied string before any application code runs.
    """
    assert _WILDCARD_ALLOW_IPS not in _runtime_cmd(), (
        "backend/Dockerfile CMD must not pass --forwarded-allow-ips=*; the "
        "wildcard makes uvicorn overwrite request.client with the left-most, "
        "caller-chosen X-Forwarded-For entry, so throttle keys and audit rows "
        "are forged before resolve_client_ip is reached."
    )


def _runtime_cmd_tokens() -> list[str]:
    """Return the runtime CMD split into tokens with its JSON-array punctuation stripped."""
    return [token.strip(_CMD_JSON_PUNCTUATION) for token in _runtime_cmd().split()]


def _runtime_cmd_flag_names() -> set[str]:
    """Return every option name in the runtime CMD, discarding any attached value."""
    return {token.split(_FLAG_VALUE_SEPARATOR)[0] for token in _runtime_cmd_tokens()}


def _uvicorn_config(*, proxy_headers: bool) -> Config:
    """Build a uvicorn config for the deployed app, leaving global logging untouched."""
    return Config(_APP_IMPORT_STRING, proxy_headers=proxy_headers, log_config=None)


def _uvicorn_default_config() -> Config:
    """Build the config uvicorn produces when the command line names no forwarding flag."""
    return Config(_APP_IMPORT_STRING, log_config=None)


def _runtime_proxy_headers() -> bool:
    """Resolve the ``proxy_headers`` setting the runtime CMD tokens hand uvicorn.

    The switch is a flag pair, so omitting both spellings does not disable
    anything -- it leaves uvicorn's own default in force.
    """
    tokens = _runtime_cmd_tokens()
    if _NO_PROXY_HEADERS_FLAG in tokens:
        return False
    if _PROXY_HEADERS_FLAG in tokens:
        return True
    return _uvicorn_default_config().proxy_headers


def _loaded_app(config: Config) -> object:
    """Return the outermost ASGI object uvicorn would serve under ``config``."""
    config.load()
    return config.loaded_app


def test_runtime_image_disables_uvicorn_proxy_header_handling() -> None:
    """The CMD must switch the proxy-header layer off explicitly, not merely omit it.

    Uvicorn's ``ProxyHeadersMiddleware`` is all-or-nothing: while it is mounted
    it rewrites ``scope["client"]`` from ``X-Forwarded-For`` as well as
    ``scope["scheme"]`` from ``X-Forwarded-Proto``, under its own allowlist
    parser, before any application code runs.  Two trust sets that can diverge
    is one too many, so the server-side layer has to be turned off and every
    forwarding decision taken inside the application against
    ``TRUSTED_PROXY_CIDRS``.
    """
    assert _NO_PROXY_HEADERS_FLAG in _runtime_cmd_tokens(), (
        f"backend/Dockerfile CMD must pass {_NO_PROXY_HEADERS_FLAG}; leaving the "
        "flag out keeps uvicorn's ProxyHeadersMiddleware mounted, so a loopback "
        "caller can still rewrite request.client and the request scheme under a "
        f"trust set the application never sees, not {TRUSTED_PROXIES_ENV_VAR}."
    )


def test_runtime_image_never_enables_uvicorn_proxy_header_handling() -> None:
    """No bare enabling token may switch the server-side rewriting layer back on."""
    assert _PROXY_HEADERS_FLAG not in _runtime_cmd_tokens(), (
        f"backend/Dockerfile CMD must not pass {_PROXY_HEADERS_FLAG}; uvicorn "
        "would rewrite request.client from the left-most X-Forwarded-For entry "
        "under a trust set the application never sees."
    )


def test_runtime_image_declares_no_server_level_forwarding_trust_set() -> None:
    """The image must name no proxy allowlist of its own, wildcard or otherwise."""
    assert _FORWARDED_ALLOW_IPS_FLAG not in _runtime_cmd_flag_names(), (
        f"backend/Dockerfile CMD must not pass {_FORWARDED_ALLOW_IPS_FLAG}; a "
        "server-level trust set can diverge from the one the application "
        f"enforces from {TRUSTED_PROXIES_ENV_VAR}."
    )


def test_uvicorn_wraps_the_app_in_a_peer_rewriter_when_no_flag_is_given(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Omitting the flag is not the same as disabling it: the default mounts the rewriter.

    This is the canary that makes the explicit flag mandatory.  If uvicorn ever
    flips its default, this case fails and the reason for the flag can be
    revisited; until then it records that a bare command line ships a layer
    which trusts loopback and rewrites the peer above the application.

    The trust set is read only through ``in``, which is the container protocol
    the class exposes.  Its address-extraction helper is deliberately left
    alone: that method has been renamed between uvicorn releases, so a test that
    called it would pin this suite to one version of a third party rather than
    to the behaviour we actually depend on.
    """
    monkeypatch.delenv(_FORWARDED_ALLOW_IPS_ENV_VAR, raising=False)
    config = _uvicorn_default_config()

    loaded = _loaded_app(config)

    assert config.proxy_headers is True
    assert isinstance(loaded, ProxyHeadersMiddleware)
    # Loopback is vouched for by default, so anything sharing the host -- a
    # sidecar, another container on the same network namespace -- may rewrite
    # the peer; a caller out on the internet may not.  That asymmetry is the
    # whole reason the layer has to be switched off rather than left at its
    # default.
    assert _UVICORN_DEFAULT_TRUSTED_PEER in loaded.trusted_hosts
    assert _CLIENT_IP not in loaded.trusted_hosts


def test_uvicorn_leaves_the_app_unwrapped_when_proxy_headers_are_disabled() -> None:
    """Turning the setting off is what actually removes the rewriting layer."""
    loaded = _loaded_app(_uvicorn_config(proxy_headers=False))

    assert not isinstance(loaded, ProxyHeadersMiddleware)


def test_runtime_cmd_serves_the_app_with_no_peer_rewriter_above_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Served exactly as the image serves it, nothing above the app can rewrite the peer.

    This ties the Dockerfile to the behaviour it is supposed to buy: the flags
    the CMD carries are fed to a real uvicorn config, and the loaded stack must
    hand requests straight to the application.
    """
    monkeypatch.delenv(_FORWARDED_ALLOW_IPS_ENV_VAR, raising=False)

    loaded = _loaded_app(_uvicorn_config(proxy_headers=_runtime_proxy_headers()))

    assert not isinstance(loaded, ProxyHeadersMiddleware), (
        "the flags in backend/Dockerfile CMD leave uvicorn's "
        "ProxyHeadersMiddleware mounted above the application, so request.client "
        "and the request scheme are rewritten before resolve_client_ip runs."
    )


def test_forwarded_allow_ips_env_var_cannot_reinstate_a_server_level_trust_set(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A wildcard in the deploy environment must not buy back a trust set the app never sees.

    Uvicorn reads ``FORWARDED_ALLOW_IPS`` when no allowlist is passed, so an
    operator or platform variable can widen server-side trust to every peer.
    With the rewriting layer switched off there is nothing for that variable to
    configure.
    """
    monkeypatch.setenv(_FORWARDED_ALLOW_IPS_ENV_VAR, _TRUST_EVERY_PEER)

    loaded = _loaded_app(_uvicorn_config(proxy_headers=_runtime_proxy_headers()))

    assert not isinstance(loaded, ProxyHeadersMiddleware), (
        f"{_FORWARDED_ALLOW_IPS_ENV_VAR} re-arms uvicorn's ProxyHeadersMiddleware "
        "to trust every peer because backend/Dockerfile CMD does not disable the "
        "proxy-header layer outright."
    )


def test_unparseable_chosen_hop_falls_back_to_socket_peer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A hop that is not an IP literal must not reach a throttle key or an audit row."""
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _TRUSTED_PROXY_NET)

    resolved = resolve_client_ip(_make_request((_PROXY_PEER, _PEER_PORT), _MALFORMED_HOP))

    assert resolved == _PROXY_PEER


def test_absent_socket_peer_is_unknown_and_never_trusted(monkeypatch: pytest.MonkeyPatch) -> None:
    """A request with no peer cannot be a trusted proxy, so the header stays ignored."""
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _TRUSTED_PROXY_NET)

    resolved = resolve_client_ip(_make_request(None, _CLIENT_IP))

    assert resolved == "unknown"


def test_ipv6_trusted_proxy_returns_forwarded_ipv6_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """IPv6 peers and IPv6 forwarded values resolve on the same rules."""
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _TRUSTED_IPV6_NET)

    resolved = resolve_client_ip(_make_request((_IPV6_PROXY_PEER, _PEER_PORT), _IPV6_CLIENT))

    assert resolved == _IPV6_CLIENT


def test_ipv4_mapped_forwarded_hop_resolves_to_its_plain_ipv4_form(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """One host gets one key: the mapped literal cannot buy a second throttle bucket."""
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _TRUSTED_PROXY_NET)

    mapped = resolve_client_ip(_make_request((_PROXY_PEER, _PEER_PORT), _MAPPED_CLIENT_IP))
    plain = resolve_client_ip(_make_request((_PROXY_PEER, _PEER_PORT), _CLIENT_IP))

    assert mapped == _CLIENT_IP
    assert mapped == plain


def test_ipv4_mapped_socket_peer_is_trusted_by_a_plain_ipv4_config_entry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A dual-stack listener's mapped peer must still read as the configured proxy."""
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _TRUSTED_PROXY_NET)

    resolved = resolve_client_ip(_make_request((_MAPPED_PROXY_PEER, _PEER_PORT), _CLIENT_IP))

    assert resolved == _CLIENT_IP


def test_peer_inside_the_configured_range_is_a_trusted_proxy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The trust projection says yes for exactly the peers the allowlist names."""
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _TRUSTED_PROXY_NET)

    assert peer_is_trusted_proxy(_make_request((_PROXY_PEER, _PEER_PORT))) is True


def test_peer_outside_the_configured_range_is_not_a_trusted_proxy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A peer the allowlist does not name gets no say over any forwarded header."""
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _TRUSTED_PROXY_NET)

    assert peer_is_trusted_proxy(_make_request((_UNTRUSTED_PEER, _PEER_PORT))) is False


def test_absent_socket_peer_is_not_a_trusted_proxy(monkeypatch: pytest.MonkeyPatch) -> None:
    """A connection with no peer at all cannot be one of our proxies."""
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _TRUSTED_PROXY_NET)

    assert peer_is_trusted_proxy(_make_request(None)) is False


@pytest.mark.parametrize("configured", [None, "", _ALL_GARBAGE_CONFIG])
def test_unconfigured_trust_makes_every_peer_untrusted(
    monkeypatch: pytest.MonkeyPatch,
    configured: str | None,
) -> None:
    """Config that names no parseable network vouches for nobody, fail-closed."""
    if configured is None:
        monkeypatch.delenv(TRUSTED_PROXIES_ENV_VAR, raising=False)
    else:
        monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, configured)

    assert peer_is_trusted_proxy(_make_request((_PROXY_PEER, _PEER_PORT))) is False


def test_ipv4_mapped_peer_is_trusted_by_a_plain_ipv4_config_entry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The trust projection folds mapped literals rather than re-deciding trust itself.

    A dual-stack listener reports the proxy as ``::ffff:192.0.2.10``, which no
    IPv4 entry contains; only reusing the resolver's own canonicalisation keeps
    the two answers from disagreeing about who a proxy is.
    """
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _PROXY_PEER)

    assert peer_is_trusted_proxy(_make_request((_MAPPED_PROXY_PEER, _PEER_PORT))) is True


def test_padding_and_blank_entries_tolerated_in_config_and_header(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Operator padding and a trailing separator change nothing on either side."""
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, f" {_PROXY_PEER} , ,{_PRIVATE_NET} ")

    resolved = resolve_client_ip(_make_request((_PRIVATE_PEER, _PEER_PORT), f"  {_CLIENT_IP} ,  "))

    assert resolved == _CLIENT_IP


@asynccontextmanager
async def _peer_client(
    db_session: AsyncSession,
    peer: tuple[str, int],
) -> AsyncIterator[AsyncClient]:
    """Yield a client whose ASGI socket peer is ``peer``, still bound to the test DB."""

    async def _override_get_session() -> AsyncIterator[AsyncSession]:
        yield db_session

    app.dependency_overrides[get_session] = _override_get_session
    transport = ASGITransport(app=app, client=peer)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            yield client
    finally:
        app.dependency_overrides.pop(get_session, None)


def _spoofed_ip(index: int) -> str:
    """Build a distinct forwarded address for attempt ``index``."""
    return f"{_SPOOFED_IP_PREFIX}{index + 1}"


async def _request_reset(client: AsyncClient, forwarded: str) -> Response:
    """Send one password-reset request for an unregistered email."""
    return await client.post(
        _RESET_PATH,
        json={"email": _UNREGISTERED_EMAIL},
        headers={"X-Forwarded-For": forwarded},
    )


def _arm_invalid_license_gate(monkeypatch: pytest.MonkeyPatch) -> None:
    """Point the license allowlist at one product whose verifier never matches."""

    async def _verify_never_matches(*_args: object, **_kwargs: object) -> None:
        return None

    monkeypatch.setenv(_PRODUCT_IDS_ENV_VAR, _ALLOWLISTED_PRODUCT)
    monkeypatch.setattr(_VERIFY_SEAM, _verify_never_matches)


async def _attempt_signup(client: AsyncClient, forwarded: str, email: str) -> Response:
    """Send one signup whose license can never verify."""
    return await client.post(
        _SIGNUP_PATH,
        json={"email": email, "password": _SIGNUP_PASSWORD, "license_key": _LICENSE_KEY},
        headers={"X-Forwarded-For": forwarded},
    )


def _proxied_chain(prepended: str, real_client: str) -> str:
    """Build the header a proxy produces when a client prepends its own entry."""
    return f"{prepended}, {real_client}"


@pytest.mark.asyncio
async def test_slowapi_buckets_per_forwarded_client_behind_trusted_proxy(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Behind a trusted proxy the per-route limiter keys on the forwarded client.

    Exhausting one forwarded client's hourly budget must not spend another
    client's, otherwise every user behind the proxy shares a single bucket.
    """
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _PROXY_PEER)

    async with _peer_client(db_session, (_PROXY_PEER, _PEER_PORT)) as client:
        for _ in range(_RESET_REQUESTS_PER_HOUR):
            allowed = await _request_reset(client, _CLIENT_IP)
            assert allowed.status_code == HTTPStatus.ACCEPTED
        capped = await _request_reset(client, _CLIENT_IP)
        other_client = await _request_reset(client, _OTHER_CLIENT_IP)

    assert capped.status_code == HTTPStatus.TOO_MANY_REQUESTS
    assert other_client.status_code == HTTPStatus.ACCEPTED


@pytest.mark.asyncio
async def test_slowapi_shares_one_bucket_when_peer_is_untrusted(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With no trusted proxy configured, rotating the header cannot buy a fresh budget."""
    monkeypatch.delenv(TRUSTED_PROXIES_ENV_VAR, raising=False)

    async with _peer_client(db_session, (_UNTRUSTED_PEER, _PEER_PORT)) as client:
        for attempt in range(_RESET_REQUESTS_PER_HOUR):
            allowed = await _request_reset(client, _spoofed_ip(attempt))
            assert allowed.status_code == HTTPStatus.ACCEPTED
        capped = await _request_reset(client, _spoofed_ip(_RESET_REQUESTS_PER_HOUR))

    assert capped.status_code == HTTPStatus.TOO_MANY_REQUESTS


@pytest.mark.asyncio
@pytest.mark.real_license_gate
@pytest.mark.usefixtures("disable_rate_limit")
async def test_invalid_license_throttle_buckets_per_forwarded_client(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The license throttle keys on the hop the proxy appended, not the one the client sent.

    Every attempt prepends a fresh entry to the chain, so a left-most read
    hands out an unlimited supply of buckets; the appended hop is constant
    and must still trip the cap, while a genuinely different client behind
    the same proxy keeps its own budget.
    """
    _arm_invalid_license_gate(monkeypatch)
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _PROXY_PEER)

    async with _peer_client(db_session, (_PROXY_PEER, _PEER_PORT)) as client:
        for attempt in range(INVALID_LICENSE_MAX_PER_HOUR):
            rejected = await _attempt_signup(
                client,
                _proxied_chain(_spoofed_ip(attempt), _CLIENT_IP),
                f"capped-{attempt}@example.com",
            )
            assert rejected.status_code == HTTPStatus.BAD_REQUEST
        capped = await _attempt_signup(
            client,
            _proxied_chain(_spoofed_ip(INVALID_LICENSE_MAX_PER_HOUR), _CLIENT_IP),
            "capped-final@example.com",
        )
        neighbour = await _attempt_signup(
            client,
            _proxied_chain(_CLIENT_IP, _OTHER_CLIENT_IP),
            "neighbour@example.com",
        )

    assert capped.status_code == HTTPStatus.TOO_MANY_REQUESTS
    assert capped.json()["detail"] == _DETAIL_THROTTLED
    assert neighbour.status_code == HTTPStatus.BAD_REQUEST
    assert neighbour.json()["detail"] == _DETAIL_INVALID_LICENSE


@pytest.mark.asyncio
@pytest.mark.real_license_gate
@pytest.mark.usefixtures("disable_rate_limit")
async def test_invalid_license_throttle_ignores_header_from_untrusted_peer(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A peer outside the configured proxy set keeps one bucket however it labels itself."""
    _arm_invalid_license_gate(monkeypatch)
    monkeypatch.setenv(TRUSTED_PROXIES_ENV_VAR, _TRUSTED_PROXY_NET)

    async with _peer_client(db_session, (_UNTRUSTED_PEER, _PEER_PORT)) as client:
        for attempt in range(INVALID_LICENSE_MAX_PER_HOUR):
            rejected = await _attempt_signup(
                client, _spoofed_ip(attempt), f"spoof-{attempt}@example.com"
            )
            assert rejected.status_code == HTTPStatus.BAD_REQUEST
        throttled = await _attempt_signup(
            client, _spoofed_ip(INVALID_LICENSE_MAX_PER_HOUR), "spoof-final@example.com"
        )

    assert throttled.status_code == HTTPStatus.TOO_MANY_REQUESTS
    assert throttled.json()["detail"] == _DETAIL_THROTTLED
