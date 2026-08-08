"""What shape a Creek Vault base URL must have, and the order those rules run in.

The pure half of the vault seam's configuration checks, split out of
:mod:`services.creek_vault_client` along the same seam
:mod:`services.creek_vault_payload` was split along: the adapters there are left
holding transports, sessions, and a connection pool, while the *rules* for
judging an untrusted configured string live in one place with no I/O in sight.
:func:`classify_vault_url` is the single judgement behind all three callers --
the constructor's raise, the factory's degrade, and the boot check -- so no two
layers can disagree about what a given string is.

A URL is refused for four reasons, and the *order* they are decided in is a
safety property rather than a taste. ``urlsplit`` puts a username in the
**scheme** slot for ``user:pass@host`` (no ``//``, so no netloc, so both userinfo
halves come back empty and the credential sits where a scheme belongs), and
reports no host at all for ``https://``. So a value that will not parse is named
before anything is read out of a parse, forbidden components before any parsed
component is quoted, and a missing host before a scheme is -- which is what makes
the one finding that repeats any part of the configured value safe to build.

This module is a leaf on purpose: :mod:`enum`, :mod:`dataclasses`, and
:mod:`urllib.parse`, and nothing else. No ``httpx``, so the rules that decide
where a credential may be sent can be read and exercised without a transport in
the way. No ``os``, because *which* string is configured is the caller's
question, and reading the environment here would fold two decisions into one
function. And no logging and no credential, because judging a value and
reporting on it are deliberately different jobs: what to *do* about a defect --
raise, warn once at boot, or degrade this one request -- is decided in
:mod:`services.creek_vault_client`, which is also the only place the
``CREEK_VAULT_API_KEY`` bearer these rules exist to protect is ever handled.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass
from urllib.parse import SplitResult, urlsplit

# Hosts for which a plaintext ``http://`` vault URL is tolerated: a developer
# running the vault on the same machine. Every other host must use TLS so the
# bearer credential never crosses a network in cleartext.
_LOOPBACK_HOSTS: frozenset[str] = frozenset({"localhost", "127.0.0.1", "::1"})

# URL components a configured vault URL must not carry, in the order their
# names are reported. ``userinfo`` (the ``user:pass@`` prefix) is itself a
# credential: httpx renders it *unmasked* in ``str(url)`` -- which is what its
# own INFO request log formats -- and, absent an explicit ``auth=``, derives
# ``BasicAuth`` from it whose auth flow *assigns* ``Authorization``, silently
# replacing our bearer with a weaker scheme. ``query`` and ``fragment`` break
# the capability URL instead: it is built by appending a path to the configured
# string, so either one swallows that path and aims the credential at an
# endpoint the operator never configured.
_FORBIDDEN_URL_PARTS = ("userinfo", "query", "fragment")

# The delimiters that *introduce* a query and a fragment. Presence is tested on
# the raw configured string rather than on the parsed component, and that is the
# whole point: ``urlsplit`` reports both as ``""`` when they are absent *and*
# when they are present but empty, so ``https://vault.example/`` and
# ``https://vault.example/?`` are indistinguishable once parsed. The second is
# the dangerous one -- the capability path is appended to the configured string,
# so a trailing ``?`` would build ``https://vault.example/?/v1/journal-entries/5``
# and send every path as a query string against ``/``, aiming the bearer
# credential at an endpoint nobody configured. Per RFC 3986 these two characters
# can only ever be those delimiters in a URL (a literal one inside a path or a
# credential must be percent-encoded), so their presence *is* the component's
# presence. Reconstructing a normalized URL from the parsed parts would also
# close the hole, but by editing an operator's configuration into something they
# did not write; refusing it and saying so is the honest half of that trade.
_QUERY_DELIMITER = "?"
_FRAGMENT_DELIMITER = "#"


def _forbidden_url_parts(url: str, parsed: SplitResult) -> tuple[str, ...]:
    """Return the names of the disallowed components ``url`` carries.

    Userinfo counts as present whenever either half is set, so a degenerate
    ``https://user@host`` (empty password) is caught alongside the full form.
    Query and fragment count as present whenever their delimiter appears at all,
    empty component included -- see :data:`_QUERY_DELIMITER`. The query
    delimiter is looked for only *before* any fragment delimiter, since a ``?``
    after a ``#`` is part of the fragment rather than a query of its own, and
    naming both components for one mistake would send an operator hunting a
    second problem they do not have.
    """
    before_fragment, _, _ = url.partition(_FRAGMENT_DELIMITER)
    carried = (
        parsed.username is not None or parsed.password is not None,
        _QUERY_DELIMITER in before_fragment,
        _FRAGMENT_DELIMITER in url,
    )
    return tuple(name for name, found in zip(_FORBIDDEN_URL_PARTS, carried, strict=True) if found)


class VaultUrlDefect(enum.StrEnum):
    """Why a configured ``CREEK_VAULT_URL`` cannot be used, in four kinds.

    A closed vocabulary, because the classifier's whole job is to answer "which
    of these": a member with no classification rule behind it would be a defect
    nothing can ever report, and a defect with no member would be one nothing can
    ever describe. The values travel in a structured log field, so they are this
    seam's contract with whoever wrote the alert -- renaming one silently retires
    somebody's filter.

    Declared in the order the classifier decides in, and that order is a safety
    property rather than a taste (see :func:`classify_vault_url`).
    """

    UNPARSEABLE = "unparseable"
    FORBIDDEN_COMPONENTS = "forbidden_components"
    MALFORMED = "malformed"
    INSECURE_TRANSPORT = "insecure_transport"


@dataclass(frozen=True)
class VaultUrlFinding:
    """One defect and the short, value-free phrase describing it.

    Frozen because this is a value, not a record of one: it is classified in one
    place and rendered in another -- a raise, a per-request WARNING, a boot
    WARNING -- and nothing between those points has any business editing it.
    Frozen also buys hashability, so two reads of one misconfiguration compare
    and deduplicate as the same finding.

    ``detail`` is always either a constant of this module or one of its own
    component names, with the single exception of the insecure-transport wording,
    which quotes a scheme and a host that three earlier classifications have
    already made safe to quote. It is never anything else drawn from the
    configured value, because this string is destined for a log line and the
    configured value is a URL that can contain a credential.
    """

    defect: VaultUrlDefect
    detail: str


# The whole detail an unparseable value gets. Static because there is no parse to
# draw a component name from, and *safe* for the same reason: anything derived
# from a string nobody could parse could be any part of it, credential included.
# Two different unparseable URLs therefore produce the identical finding.
_UNPARSEABLE_DETAIL = "the configured value could not be parsed as a URL"

# The components a URL must actually have before a request can be built for it,
# in the order a finding names them. Two names and no more, which is what keeps a
# MALFORMED detail a closed vocabulary -- "scheme", "host", or "scheme, host" --
# rather than a rendering of whatever the operator typed.
_REQUIRED_URL_PARTS = ("scheme", "host")


def _transport_is_secure(parsed: SplitResult) -> bool:
    """Report whether this scheme and host may carry the bearer credential.

    TLS, or plaintext to a host that never leaves the machine. The loopback
    exemption is the long-standing one that lets a developer run a vault locally;
    every other host must use ``https``, because cleartext to a remote host would
    put the credential on a network.
    """
    return parsed.scheme == "https" or (
        parsed.scheme == "http" and parsed.hostname in _LOOPBACK_HOSTS
    )


def _transport_finding(parsed: SplitResult) -> VaultUrlFinding | None:
    """Classify what a parsed, component-clean URL still gets wrong, or ``None``.

    Split out from :func:`classify_vault_url` because these are the two rules
    that may speak about a parse at all, and they must run in this order.
    Missing components come first: ``https://`` carries a perfectly good scheme
    and names no host, so a check that stopped at the scheme would accept a URL
    no request can be built for -- and ``ftp://`` is answerable both ways, where
    "there is no host" is the true and value-free answer.

    Only once a host is known to exist may a finding quote a scheme, which is why
    the insecure-transport detail is the one place in this seam that repeats any
    part of the configured value. That wording is the one the refusal has always
    carried, and it is what an operator actually needs to see.
    """
    missing = tuple(
        name
        for name, present in zip(
            _REQUIRED_URL_PARTS, (bool(parsed.scheme), bool(parsed.hostname)), strict=True
        )
        if not present
    )
    if missing:
        return VaultUrlFinding(VaultUrlDefect.MALFORMED, ", ".join(missing))
    if _transport_is_secure(parsed):
        return None
    return VaultUrlFinding(
        VaultUrlDefect.INSECURE_TRANSPORT,
        f"scheme {parsed.scheme!r}, host {parsed.hostname!r}",
    )


def classify_vault_url(url: str) -> VaultUrlFinding | None:
    """Name the one defect that makes ``url`` unusable, or ``None`` if it is fine.

    The single judgement behind all three callers -- the constructor's raise, the
    factory's degrade, and the boot check -- so no two layers can disagree about
    what a given string is. A disagreement is how a URL ends up refused in one
    place and accepted in another.

    The order is the safety property. ``urlsplit`` puts a username in the
    *scheme* slot for ``user:pass@host`` (no ``//``, so no netloc, so both
    userinfo halves come back empty and the credential sits where a scheme
    belongs), and reports no host at all for ``https://``. So a finding may quote
    a scheme only after userinfo has been excluded *and* a host is known to
    exist, which is exactly what running forbidden-components before
    :func:`_transport_finding`, and missing-components before the transport rule,
    guarantees.

    The parser's own ``ValueError`` is discarded rather than inspected, and that
    is deliberate: ``urlsplit`` quotes the whole offending netloc back in its
    message when it refuses one under NFKC normalization, and a netloc includes
    userinfo. That exception object is the one thing in this seam guaranteed to
    hold a credential when the configured URL has one, so it is never bound,
    rendered, or chained to.

    Nothing is ever normalized. A value is judged as configured and refused as
    configured -- reconstructing a URL from its parsed parts would close the same
    holes by editing something nobody wrote, and a deployment replicating to an
    endpoint subtly different from the configured one is worse than one
    replicating nowhere and saying so.
    """
    try:
        parsed = urlsplit(url)
    except ValueError:
        return VaultUrlFinding(VaultUrlDefect.UNPARSEABLE, _UNPARSEABLE_DETAIL)
    parts = _forbidden_url_parts(url, parsed)
    if parts:
        return VaultUrlFinding(VaultUrlDefect.FORBIDDEN_COMPONENTS, ", ".join(parts))
    return _transport_finding(parsed)
