"""Which destinations a *user-supplied* vault URL may name, decided from the string alone.

The pure half of the request-forgery guard on ``PUT /vault/connection``, split
from :mod:`services.creek_vault_url_resolution` along the same seam
:mod:`services.creek_vault_url` was split along: the rules for judging a
destination live in one place with no I/O in sight, so they can be exercised
exhaustively and instantly, and so the resolving half has exactly one question
left to answer.

These rules sit *on top of* the shared ones rather than replacing them, and that
distinction is the whole design. :func:`~services.creek_vault_url.classify_vault_url`
judges the operator's deployment-wide ``CREEK_VAULT_URL`` and deliberately
exempts loopback, because whoever set that variable owns the machine the process
runs on and can already reach every host it could name -- pointing it at
``127.0.0.1`` escalates nothing and is the documented local-vault setup. A URL
that arrived in a request body was chosen by somebody who owns none of that, so
for *that* value the loopback exemption is the vulnerability. Two values, two
threat models, two rule sets; narrowing the shared one instead would break every
developer's local vault, silently, since replication would simply stop.

The defect vocabulary is its own enum for the same reason it is its own module.
:class:`~services.creek_vault_url.VaultUrlDefect` is keyed exhaustively by a
refusal-clause table in :mod:`services.creek_vault_client` and indexed
unguarded, so a member added there would be a ``KeyError`` waiting on the
constructor's raise path. A separate vocabulary cannot reach that table at all.

Everything here is decided from a string. What a *name* points at cannot be, so
the name rules answer only the question they can -- is this name from a zone that
by definition never leaves the local network -- and a ``None`` from this module
means "not yet decided", never "allowed". The resolver is what turns the rest
into an answer.

A leaf, like its sibling: :mod:`enum`, :mod:`dataclasses`, :mod:`ipaddress`, and
:mod:`urllib.parse`, and nothing else. No socket, so a rule can be read without a
network in the way; no logging and no credential, because judging a value and
reporting on it are deliberately different jobs.
"""

from __future__ import annotations

import enum
import ipaddress
from dataclasses import dataclass
from urllib.parse import urlsplit

# The two address classes this module can be handed, as an implicit alias (a
# bare assignment) rather than a ``TypeAlias`` annotation or the ``type``
# keyword: the newer spelling is a syntax error on the 3.11 cross-version job.
IpAddress = ipaddress.IPv4Address | ipaddress.IPv6Address

# The one name RFC 6761 reserves to this host, matched exactly because it has no
# dot to hang a suffix rule on.
_BLOCKED_HOST_NAMES: frozenset[str] = frozenset({"localhost"})

# Zones that name a machine on this network by definition, whatever they resolve
# to today. ``.local`` is multicast DNS and ``.internal`` is the convention every
# cloud provider's private zone follows -- including the one serving instance
# metadata, which is the single most valuable thing an attacker can aim a
# server-side connection at.
_BLOCKED_HOST_SUFFIXES = (".internal", ".local")

# The root label, written explicitly in a fully-qualified name. Resolvers strip
# it, so a suffix rule written against the raw string would accept the exact name
# it was written to refuse: ``vault.local.`` is ``vault.local`` and the trailing
# dot must not launder it.
_ROOT_LABEL = "."

# The four IPv6 prefixes that carry an IPv4 address in their low 32 bits and say
# unambiguously where those bits begin: the deprecated IPv4-compatible block, the
# IPv4-mapped block, RFC 2765's IPv4-translated block, and the RFC 6052
# well-known prefix a DNS64 resolver synthesizes answers with. All four reach the
# IPv4 host they carry, and three of the four report ``is_global`` on the outer
# form, because the reserved-range tables describe the address as written rather
# than the address it translates to.
_IPV4_EMBEDDING_PREFIXES = (
    ipaddress.IPv6Network("::/96"),
    ipaddress.IPv6Network("::ffff:0:0/96"),
    ipaddress.IPv6Network("::ffff:0:0:0/96"),
    ipaddress.IPv6Network("64:ff9b::/96"),
)

# Where the embedded address sits in all four: the low 32 bits, which is what
# makes the list above the list it is rather than every prefix ever standardised.
_EMBEDDED_IPV4_MASK = 0xFFFFFFFF


class UserVaultUrlDefect(enum.StrEnum):
    """Why a user-supplied vault URL names a destination this server may not dial.

    Two members, because there are exactly two answers this guard can give: the
    destination is one only this deployment can reach, or nobody can say what it
    is. A closed vocabulary for the reason its sibling's is closed -- a member
    with no rule behind it is a defect nothing can report.

    The values travel in a structured log field and, through the router, in the
    refusal code a client renders, so they are this seam's contract with whoever
    wrote the alert. Renaming one silently retires somebody's filter.
    """

    PRIVATE_ADDRESS = "private_address"
    UNRESOLVABLE_HOST = "unresolvable_host"


@dataclass(frozen=True)
class UserVaultUrlFinding:
    """One defect and the short, value-free phrase describing it.

    Frozen because a finding is classified in one place and rendered in another
    -- a WARNING, a 422 code -- and nothing between those two points has any
    business editing it. Frozen also buys hashability, so two reads of one bad
    URL compare and deduplicate as the same finding.

    ``detail`` is always a constant of this seam's own words and never anything
    drawn from the value being judged, with no exception at all. Its sibling
    :class:`~services.creek_vault_url.VaultUrlFinding` allows itself one wording
    that quotes a scheme and host, and can only do so because three earlier
    classifications have already ruled a credential out of that parse. Nothing
    here runs early enough to have earned that, and this string reaches a log
    line whose subject is a URL a stranger typed.
    """

    defect: UserVaultUrlDefect
    detail: str


# What a refusal says about each of the two things decided here. Static, so two
# different bad URLs produce the identical finding and no rendering of either can
# reach a log. They are separate wordings because they are separate news: an
# address is judged on sight, a name is judged by the zone it sits in.
_LITERAL_ADDRESS_DETAIL = "the URL names an address that is not globally routable"
_LOCAL_ZONE_DETAIL = "the URL names a host in a zone reserved to the local network"

_LITERAL_ADDRESS_FINDING = UserVaultUrlFinding(
    UserVaultUrlDefect.PRIVATE_ADDRESS, _LITERAL_ADDRESS_DETAIL
)
_LOCAL_ZONE_FINDING = UserVaultUrlFinding(UserVaultUrlDefect.PRIVATE_ADDRESS, _LOCAL_ZONE_DETAIL)


def _embedded_ipv4(address: IpAddress) -> ipaddress.IPv4Address | None:
    """Return the IPv4 address ``address`` translates to, or ``None`` for none.

    Split out of :func:`_effective_address` because the membership test and the
    mask are one idea and the caller has another; folded together they also cost
    more branches than the complexity gate allows a single block.

    **The well-known NAT64 prefix is unwrapped, not banned.** A ban is the
    shorter rule and would take the feature away from every IPv6-only deployment
    at once: with DNS64 in front of it, ``64:ff9b::<the A record>`` is not an
    exotic answer for a vault name, it is the only answer any name ever has.
    Unwrapping decides by the destination instead, so a public vault stays
    dialable and a synthesis of the metadata endpoint does not.

    **RFC 8215's local-use** ``64:ff9b:1::/48`` **is deliberately absent, and
    completing the table with it would be a regression.** ``ipaddress`` already
    reports that block non-global, so every address in it is refused as it
    stands; adding it here would *un*-refuse the ones carrying a public IPv4 in
    their low 32 bits. It could not be read safely anyway, since RFC 6052 permits
    six embedding lengths inside it and nothing in the address says which was
    used -- a low-32-bit reading there is a guess, and a guess that reads a
    public address out of an address translating to the metadata endpoint.

    **Loopback and the unspecified address survive this**, which is worth stating
    because ``::/96`` contains both and unwrapping it is the obvious way to blow
    a hole in loopback while fixing NAT64. Under the low-32-bit reading ``::1``
    becomes ``0.0.0.1`` and ``::`` becomes ``0.0.0.0``; neither is globally
    routable, so both stay blocked by the same predicate as before.
    """
    if not isinstance(address, ipaddress.IPv6Address):
        return None
    if not any(address in prefix for prefix in _IPV4_EMBEDDING_PREFIXES):
        return None
    return ipaddress.IPv4Address(int(address) & _EMBEDDED_IPV4_MASK)


def _effective_address(value: str | IpAddress) -> IpAddress:
    """Return the address ``value`` actually reaches, unwrapping any embedded IPv4.

    ``::ffff:169.254.169.254`` and ``169.254.169.254`` are one destination
    wearing two spellings, and the socket layer will happily connect the first to
    the second. A rule reading only the outer form therefore lets the inner one
    straight through. Unwrapping is also what keeps the answer stable across
    interpreter versions, which have not always agreed on how a mapped address
    should classify -- so it is done here rather than left to the property.

    The mapped form is only the spelling everyone knows. Three more prefixes
    carry an IPv4 address the same way and are *not* unwrapped by the
    interpreter, so each of them names an internal host while reporting
    ``is_global``; :func:`_embedded_ipv4` holds the list and the argument for its
    exact membership.

    Both spellings of the input are accepted because both arrive: a URL literal
    parses to a string and so does every answer a resolver hands back, while a
    caller that already parsed one has no reason to re-render it.
    """
    address = ipaddress.ip_address(value) if isinstance(value, str) else value
    embedded = _embedded_ipv4(address)
    return address if embedded is None else embedded


def address_is_blocked(value: str | IpAddress) -> bool:
    """Report whether this server must refuse to open a connection to ``value``.

    One predicate, ``is_global``, rather than a ladder of CIDR comparisons, and
    the choice is substantive rather than stylistic. ``is_private`` is the
    obvious-looking spelling and is *insufficient*: carrier-grade NAT space
    reports ``is_private == False`` while ``100.64.0.1`` is shared with an ISP
    and routable from nowhere public. ``is_global`` is the question actually
    being asked -- can a stranger on the internet reach this address -- and its
    negation covers loopback, both link-local ranges (the cloud metadata
    endpoint among them), all three RFC 1918 blocks, unique-local, the
    unspecified address, and the documentation ranges, in one rule that a new
    reserved allocation extends for free.

    A ladder would also be graded: enumerating a dozen ranges by hand is exactly
    the shape the complexity gate exists to refuse, and every branch of it is a
    place to leave one out.
    """
    return not _effective_address(value).is_global


def blocked_hostname(host: str) -> bool:
    """Report whether ``host`` is a name that can only ever mean a local machine.

    Decided without a lookup, because these zones need none: whatever they
    resolve to, they name something on this network by definition. A name that is
    not from one of them is not judged here at all -- refusing every unfamiliar
    name would refuse every real vault, and what an ordinary name points at is a
    question only the resolver can answer.

    Case is folded because DNS is case-insensitive and an attacker's shift key is
    free, and the root label is dropped first, because a suffix rule that did not
    would accept ``vault.local.`` -- one character, and the whole bypass.
    """
    normalized = host.removesuffix(_ROOT_LABEL).lower()
    return normalized in _BLOCKED_HOST_NAMES or normalized.endswith(_BLOCKED_HOST_SUFFIXES)


def classify_user_vault_url_host(host: str) -> UserVaultUrlFinding | None:
    """Name what makes ``host`` undialable on sight, or ``None`` if nothing does.

    Dispatches on whether the host parses as an address, which is what makes the
    ``https://10.0.0.7`` case answerable synchronously and for free: a literal
    needs no lookup and gets none. ``ValueError`` from the parser is the signal
    that this is a name rather than an address, so it is a branch rather than a
    fault -- and it is discarded unbound, since the string it would quote came
    out of a request body.

    A ``None`` here means "not yet decided". Reading it as approval is precisely
    how this guard would come to be bypassed by a name, so every caller pairs it
    with :func:`~services.creek_vault_url_resolution.classify_resolved_user_vault_url`
    or accepts that it has only asked half the question.
    """
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return _LOCAL_ZONE_FINDING if blocked_hostname(host) else None
    return _LITERAL_ADDRESS_FINDING if address_is_blocked(address) else None


def vault_url_host(url: str) -> str:
    """Return the host ``url`` names, lowercased and unbracketed, or ``""`` for none.

    A parse the three callers of these rules would otherwise each repeat, and one
    they cannot be trusted to repeat safely. ``urlsplit`` raises on a netloc it
    refuses under NFKC normalization and quotes the whole netloc -- userinfo
    included -- in the message, so that exception object is the one thing in this
    seam guaranteed to hold a credential when the URL has one. It is never bound,
    rendered, or chained to; the answer is simply "this URL names no host", which
    every caller already has to handle.

    The empty answer matters most on the dial-time path, which reaches a stored
    row without the shared classifier having run. A raise there would run inside
    a per-request dependency and cost the writer the entry they were saving, for
    a URL that is about to be refused anyway.
    """
    try:
        return urlsplit(url).hostname or ""
    except ValueError:
        return ""
