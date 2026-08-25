"""Which destinations a *user-supplied* vault URL may name, decided without a lookup.

The pure half of the request-forgery guard, split from
:mod:`services.creek_vault_url_resolution` along the same seam
:mod:`services.creek_vault_url` was split from the adapters: the rules for
judging a destination live in one place with no I/O in sight, so they can be
exercised exhaustively and instantly, and so the resolving half has exactly one
question to answer rather than two.

These rules sit *on top of* the shared ones rather than replacing them, and the
distinction is the whole design. :func:`~services.creek_vault_url.classify_vault_url`
judges the operator's deployment-wide ``CREEK_VAULT_URL`` and deliberately
exempts loopback, because the person who set that variable already owns the
machine. A URL that arrived in a request body was chosen by someone who does
not, so for that value the loopback exemption is the vulnerability, and these
rules close it -- for that value only.

Everything here is decided from a string. What a *name* points at cannot be, so
the name rules answer only the question they can: is this name from a zone that
by definition never leaves the local network. The rest waits for the resolver.

Two things are easy to get wrong and are pinned individually. Documentation
ranges are not globally routable, so they are blocked, and any happy path built
on ``203.0.113.x`` would be testing the guard's failure rather than its success.
And an IPv4 address wearing an IPv6 literal's spelling is the same destination:
``::ffff:169.254.169.254`` and ``169.254.169.254`` are one host, and a rule that
reads only the outer form lets the second in through the first.
"""

from __future__ import annotations

import dataclasses
import ipaddress

import pytest

from services.creek_vault_url import VaultUrlDefect, classify_vault_url
from services.creek_vault_url_user import (
    UserVaultUrlDefect,
    UserVaultUrlFinding,
    address_is_blocked,
    blocked_hostname,
    classify_user_vault_url_host,
)

# The all-zero address, built rather than written. It reaches this host, so it
# belongs in the blocked set below; spelled as a literal it also reads to a
# linter as a server binding to every interface, which it is not.
_UNSPECIFIED_ADDRESS = ipaddress.IPv4Address(0).compressed

# Every address class the server must never be talked into dialling, one
# representative each, with what it is. These are separate rules that fail
# separately: a guard that catches loopback and misses link-local leaves the
# cloud metadata endpoint wide open.
_BLOCKED_ADDRESSES = [
    ("127.0.0.1", "IPv4 loopback"),
    ("::1", "IPv6 loopback"),
    ("169.254.169.254", "IPv4 link-local, where cloud instance metadata lives"),
    ("fe80::1", "IPv6 link-local"),
    ("10.0.0.7", "RFC 1918, the ten-dot block"),
    ("172.16.0.1", "RFC 1918, the 172.16 block"),
    ("192.168.1.5", "RFC 1918, the block a home or office network uses"),
    ("100.64.0.1", "carrier-grade NAT space, shared with the ISP"),
    ("fc00::1", "IPv6 unique-local"),
    (_UNSPECIFIED_ADDRESS, "the unspecified address, which reaches this host"),
    ("::ffff:169.254.169.254", "the metadata endpoint as an IPv4-mapped IPv6 literal"),
    ("203.0.113.10", "TEST-NET-3, reserved for documentation and routed nowhere"),
]

# Addresses that are genuinely reachable from the public internet and belong to
# nobody's private network. Short on purpose: almost every address that looks
# convenient in a test is reserved for something.
_ROUTABLE_ADDRESSES = [
    ("8.8.8.8", "a public resolver"),
    ("1.1.1.1", "another public resolver"),
    ("93.184.216.34", "an ordinary public web host"),
    ("2001:4860:4860::8888", "the IPv6 form of a public resolver"),
]

# Names that can only ever mean a machine on this network, whatever they
# resolve to today. ``.local`` is multicast DNS, ``.internal`` is the
# convention every cloud provider's private zone follows, and ``localhost`` is
# reserved to this host by RFC 6761.
_BLOCKED_NAMES = [
    ("localhost", "reserved to this host"),
    ("vault.local", "the multicast-DNS zone"),
    ("backend.internal", "a private cloud zone"),
    ("metadata.google.internal", "the metadata endpoint, reached by name"),
    ("LOCALHOST", "the same reserved name, shouted"),
    ("Vault.Local", "mixed case, because DNS names are case-insensitive"),
    ("BACKEND.INTERNAL", "the private zone, shouted"),
]

_ORDINARY_NAMES = ["vault.example.com", "creek.example.org", "a-vault.co.uk"]

_METADATA_ADDRESS = "169.254.169.254"
_MAPPED_METADATA_ADDRESS = "::ffff:169.254.169.254"
_PRIVATE_ADDRESS = "10.0.0.7"
_ROUTABLE_ADDRESS = "8.8.8.8"


@pytest.mark.parametrize(("address", "description"), _BLOCKED_ADDRESSES)
def test_every_address_class_the_server_must_not_dial_is_blocked(
    address: str, description: str
) -> None:
    """One case per reserved range, because they are one rule each.

    Written against the string form and the parsed form both, since the resolver
    hands over one and a URL literal parses to the other, and a guard that only
    understood one of them would have a whole half of its callers unprotected.
    """
    assert address_is_blocked(address) is True, description
    assert address_is_blocked(ipaddress.ip_address(address)) is True, description


@pytest.mark.parametrize(("address", "description"), _ROUTABLE_ADDRESSES)
def test_a_globally_routable_address_is_not_blocked(address: str, description: str) -> None:
    """The guard refuses private destinations, not the internet.

    The negative half, and it is not decoration: every assertion in this file is
    satisfied by a predicate that returns ``True`` unconditionally, which would
    close the hole by deleting the feature -- nobody could connect a vault at all.
    """
    assert address_is_blocked(address) is False, description


def test_an_ipv4_mapped_address_is_judged_by_the_address_it_carries() -> None:
    """``::ffff:169.254.169.254`` is the metadata endpoint, spelled differently.

    An IPv4-mapped IPv6 literal is one destination wearing two forms, and a
    rule that inspects only the outer form lets the inner one straight through:
    the socket layer will happily connect it to the IPv4 host. So the mapped
    address is unwrapped and the address it carries is what gets judged, which
    is also what keeps the answer the same across interpreter versions that
    disagree about how a mapped address should classify.
    """
    assert address_is_blocked(_MAPPED_METADATA_ADDRESS) is True
    assert address_is_blocked(_METADATA_ADDRESS) is True
    assert ipaddress.IPv6Address(_MAPPED_METADATA_ADDRESS).ipv4_mapped == ipaddress.IPv4Address(
        _METADATA_ADDRESS
    )


@pytest.mark.parametrize(("host", "description"), _BLOCKED_NAMES)
def test_a_name_from_a_local_only_zone_is_blocked_whatever_its_case(
    host: str, description: str
) -> None:
    """These zones name a machine on this network by definition, so no lookup is owed.

    Case is folded because DNS is case-insensitive and an attacker's shift key
    is free: a guard that matched ``.internal`` and not ``.INTERNAL`` would be a
    guard with a documented bypass.
    """
    assert blocked_hostname(host) is True, description


def test_a_fully_qualified_local_name_keeps_its_zone_when_the_root_dot_is_written() -> None:
    """``vault.local.`` is ``vault.local``, and the trailing dot must not launder it.

    The root label is legal in a URL and resolvers strip it, so a suffix match
    written against the raw string accepts the exact name it was written to
    refuse. It is one character and it is the whole bypass.
    """
    assert blocked_hostname("vault.local.") is True
    assert blocked_hostname("metadata.google.internal.") is True
    assert blocked_hostname("localhost.") is True


@pytest.mark.parametrize("host", _ORDINARY_NAMES)
def test_an_ordinary_public_name_is_not_blocked_by_its_spelling(host: str) -> None:
    """A name that is not from a reserved zone is not judged here at all.

    What it points at is a question this module cannot answer, and answering it
    anyway -- by refusing every name it does not recognise -- would refuse every
    real vault. The resolver decides these; this rule set only decides the ones
    that need no resolver.
    """
    assert blocked_hostname(host) is False


def test_a_literal_address_is_judged_on_sight_and_a_name_is_deferred() -> None:
    """The classifier dispatches on whether the host parses as an address.

    A literal needs no lookup and gets none, which is what makes the
    ``https://10.0.0.7`` case answerable synchronously and cheaply. A name that
    is not from a reserved zone yields no finding *here*, and that ``None`` means
    "not yet decided" rather than "allowed" -- the resolving half is what turns it
    into an answer, and reading it as approval is how the guard would come to be
    bypassed by a name.
    """
    private = classify_user_vault_url_host(_PRIVATE_ADDRESS)
    assert private is not None
    assert private.defect is UserVaultUrlDefect.PRIVATE_ADDRESS

    named = classify_user_vault_url_host("metadata.google.internal")
    assert named is not None
    assert named.defect is UserVaultUrlDefect.PRIVATE_ADDRESS

    assert classify_user_vault_url_host(_ROUTABLE_ADDRESS) is None
    assert classify_user_vault_url_host("vault.example.com") is None


@pytest.mark.parametrize("host", [_PRIVATE_ADDRESS, _MAPPED_METADATA_ADDRESS, "vault.local"])
def test_a_finding_never_repeats_the_host_it_was_asked_about(host: str) -> None:
    """The detail is this module's own words, not a rendering of the input.

    A finding is destined for a log line and, through the router, for a client
    that may log it too. The shared classifier holds the same discipline for the
    same reason, and it is why only the one wording that has already had a
    credential ruled out is allowed to quote anything.
    """
    finding = classify_user_vault_url_host(host)
    assert finding is not None
    assert finding.detail
    assert host not in finding.detail


def test_the_defect_vocabulary_is_closed_and_its_wire_values_are_stable() -> None:
    """Two members, two strings, and no third thing this guard can decide.

    The values reach a structured log field and the router's refusal code, so
    they are this seam's contract with whoever wrote the alert and with the
    client rendering the error. Renaming one silently retires somebody's filter.
    """
    assert {member.value for member in UserVaultUrlDefect} == {
        "private_address",
        "unresolvable_host",
    }
    assert UserVaultUrlDefect.PRIVATE_ADDRESS.value == "private_address"
    assert UserVaultUrlDefect.UNRESOLVABLE_HOST.value == "unresolvable_host"


def test_a_finding_is_an_immutable_pair_of_defect_and_detail() -> None:
    """Frozen, because a finding is classified in one place and rendered in another.

    Nothing between those two points has any business editing it, and frozen
    buys hashability besides, so two reads of one bad URL compare and deduplicate
    as the same finding.
    """
    assert tuple(field.name for field in dataclasses.fields(UserVaultUrlFinding)) == (
        "defect",
        "detail",
    )
    finding = UserVaultUrlFinding(
        defect=UserVaultUrlDefect.PRIVATE_ADDRESS, detail="a private destination"
    )
    twin = UserVaultUrlFinding(
        defect=UserVaultUrlDefect.PRIVATE_ADDRESS, detail="a private destination"
    )

    assert finding == twin
    assert len({finding, twin}) == 1
    field_name = "detail"
    with pytest.raises(dataclasses.FrozenInstanceError):
        setattr(finding, field_name, "edited")


def test_a_credential_in_the_url_is_named_before_the_host_behind_it() -> None:
    """The shared rules run first, so userinfo outranks a private destination.

    A userinfo prefix in front of a private address is two defects at once, and
    only one may be reported. Userinfo has to win: it is itself a credential, ``urlsplit`` puts
    it in the *scheme* slot when the ``//`` is missing, and no finding may quote
    a host until the parse it came from is known to hold no secret. A new guard
    that ran ahead of the shared ones would reorder that silently, and the first
    sign would be a credential in a log line.
    """
    finding = classify_vault_url(f"https://user:pw@{_PRIVATE_ADDRESS}")  # pragma: allowlist secret

    assert finding is not None
    assert finding.defect is VaultUrlDefect.FORBIDDEN_COMPONENTS
    assert "userinfo" in finding.detail
    assert _PRIVATE_ADDRESS not in finding.detail
