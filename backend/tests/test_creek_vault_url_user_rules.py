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

_METADATA_ADDRESS = "169.254.169.254"
_MAPPED_METADATA_ADDRESS = "::ffff:169.254.169.254"
_PRIVATE_ADDRESS = "10.0.0.7"
_ROUTABLE_ADDRESS = "8.8.8.8"
_PUBLIC_WEB_HOST_ADDRESS = "93.184.216.34"

# The four prefixes that carry an IPv4 address in their low 32 bits and leave no
# doubt about where it begins. ``::/96`` is the deprecated IPv4-compatible form,
# ``::ffff:0:0/96`` the IPv4-mapped one, ``::ffff:0:0:0/96`` RFC 2765's
# IPv4-translated block, and ``64:ff9b::/96`` the well-known prefix a DNS64
# resolver synthesizes an AAAA with. All four reach the IPv4 host they carry,
# and three of the four report ``is_global`` on the outer form.
_IPV4_COMPATIBLE_PREFIX = "::"
_IPV4_MAPPED_PREFIX = "::ffff:0:0"
_IPV4_TRANSLATED_PREFIX = "::ffff:0:0:0"
_NAT64_WELL_KNOWN_PREFIX = "64:ff9b::"

# RFC 8215 reserves this for a network's own NAT64, and permits the IPv4 address
# to sit at any of six offsets inside it. Nothing in the address says which, so
# there is no unwrapping it -- only refusing it.
_NAT64_LOCAL_USE_PREFIX = "64:ff9b:1::"


def _embedded_ipv4(prefix: str, address: str) -> str:
    """Render ``address`` sitting in the low 32 bits of ``prefix``.

    Computed rather than written out, because these literals are hex renderings
    of a dotted quad -- ``64:ff9b::a9fe:a9fe`` for the metadata endpoint -- and a
    hand-typed one that was wrong by a nibble would name some unrelated address
    the guard blocks for an unrelated reason, leaving the case green and empty.
    """
    embedded = int(ipaddress.IPv6Address(prefix)) | int(ipaddress.IPv4Address(address))
    return ipaddress.IPv6Address(embedded).compressed


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
    (
        _embedded_ipv4(_NAT64_WELL_KNOWN_PREFIX, _METADATA_ADDRESS),
        "the metadata endpoint as a DNS64 resolver synthesizes it",
    ),
    (
        _embedded_ipv4(_NAT64_WELL_KNOWN_PREFIX, _PRIVATE_ADDRESS),
        "an RFC 1918 host as a DNS64 resolver synthesizes it",
    ),
    (
        _embedded_ipv4(_IPV4_COMPATIBLE_PREFIX, _PRIVATE_ADDRESS),
        "an RFC 1918 host in the deprecated IPv4-compatible form",
    ),
    (
        _embedded_ipv4(_IPV4_TRANSLATED_PREFIX, _PRIVATE_ADDRESS),
        "an RFC 1918 host in the RFC 2765 IPv4-translated form",
    ),
    (
        _embedded_ipv4(_NAT64_LOCAL_USE_PREFIX, _METADATA_ADDRESS),
        "the metadata endpoint under the local-use NAT64 prefix",
    ),
    (
        _embedded_ipv4(_NAT64_LOCAL_USE_PREFIX, _PUBLIC_WEB_HOST_ADDRESS),
        "a public address under the local-use NAT64 prefix, whose embedding is ambiguous",
    ),
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


def test_an_embedded_ipv4_is_judged_by_the_address_it_carries_whatever_the_prefix() -> None:
    """Four spellings, one destination, and only one of them classifies as private today.

    The IPv4-mapped form is the familiar one and it is the *only* one the
    interpreter unwraps for itself. The other three -- the deprecated
    IPv4-compatible block, RFC 2765's IPv4-translated block, and the well-known
    NAT64 prefix a DNS64 resolver synthesizes with -- all report ``is_global``
    while naming the metadata endpoint, because the reserved-range tables are
    written about the outer address and these carry their meaning in the low 32
    bits. The socket layer resolves that meaning; a guard reading the outer form
    does not.

    Each pairing is asserted against the bare IPv4 verdict rather than against
    ``True``, so the case says what it means: these are the same destination and
    must get the same answer.
    """
    for prefix in (
        _IPV4_COMPATIBLE_PREFIX,
        _IPV4_MAPPED_PREFIX,
        _IPV4_TRANSLATED_PREFIX,
        _NAT64_WELL_KNOWN_PREFIX,
    ):
        spelling = _embedded_ipv4(prefix, _METADATA_ADDRESS)
        assert address_is_blocked(spelling) is address_is_blocked(_METADATA_ADDRESS), spelling
        assert (
            ipaddress.IPv6Address(spelling).packed[-4:]
            == ipaddress.IPv4Address(_METADATA_ADDRESS).packed
        ), spelling


def test_a_synthesized_answer_for_a_public_host_is_still_reachable() -> None:
    """The rule for an embedded address is an unwrap, and this is the whole reason.

    Refusing these prefixes outright is the shorter rule and it would take the
    feature away from every IPv6-only deployment at once: with DNS64 in front of
    it, a synthesized AAAA is not an exotic answer for a vault, it is the only
    answer any name ever has. Unwrapping refuses the metadata case in the table
    above and keeps this one, which is the difference between a guard and an
    outage nobody can work around.
    """
    for prefix in (_NAT64_WELL_KNOWN_PREFIX, _IPV4_TRANSLATED_PREFIX):
        spelling = _embedded_ipv4(prefix, _PUBLIC_WEB_HOST_ADDRESS)
        assert address_is_blocked(spelling) is False, spelling
    assert address_is_blocked(_PUBLIC_WEB_HOST_ADDRESS) is False


def test_the_local_use_nat64_prefix_is_refused_whatever_it_appears_to_embed() -> None:
    """An address whose format is ambiguous cannot be unwrapped, so it is refused.

    RFC 8215 hands ``64:ff9b:1::/48`` to a network for its own NAT64 and lets the
    IPv4 address sit at any of six permitted offsets inside it; nothing in the
    address says which was used. So a low-32-bit reading is a guess, and a guess
    that reads a public address out of an address translating to the metadata
    endpoint is a bypass with a citation attached. Both cases are here because
    the failing-closed only means something if it also refuses the one that looks
    innocent -- an implementation that unwrapped this prefix would keep the first
    assertion and lose the second.
    """
    assert address_is_blocked(_embedded_ipv4(_NAT64_LOCAL_USE_PREFIX, _METADATA_ADDRESS)) is True
    assert (
        address_is_blocked(_embedded_ipv4(_NAT64_LOCAL_USE_PREFIX, _PUBLIC_WEB_HOST_ADDRESS))
        is True
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
