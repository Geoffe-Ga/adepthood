"""Decide which authority the app is willing to speak as, from operator config.

Every absolute URL this app mints has two halves, and both are written by
whoever sent the request unless something settles them first.  :mod:`client_ip`
and :mod:`middleware.forwarded_proto` between them settle the scheme half
against ``TRUSTED_PROXY_CIDRS``; this module settles the authority half against
``ALLOWED_HOSTS``, so the two halves are answered on the same terms rather than
one being an invariant and the other a suggestion.

The visible consequence is Starlette's trailing-slash 307.  Its ``Location`` is
built from ``scope["scheme"]`` and the ``Host`` header at *routing* time, before
any dependency or auth check runs, so a caller sending ``Host: evil.example``
gets an unauthenticated ``Location: http://evil.example/practices/`` out of the
app.  That is a cache-poisoning primitive the moment anything caches in front of
the API, and it exists on every collection route at once because every router in
the tree uses Starlette's default ``redirect_slashes=True``.

*Settle, never reject.*  A non-allowlisted ``Host`` has its authority replaced
with the operator's canonical one and the request proceeds normally.  Rejecting
would be the more obvious control and is the wrong one here for three separate
reasons: the platform's health prober's ``Host`` cannot be known from this
repository, and ``backend/railway.toml`` retries a failing probe three times
failing the deploy; a rejection minted above the CORS layer is a response no
browser can read; and a rejection needs a path exemption for the probes, which
is a second mechanism to get wrong.  Settling dissolves all three -- nothing is
ever refused, so nothing that must stay reachable can become unreachable -- and
it is the same shape the scheme half already takes: an inbound value the app
declines to believe is replaced by the operator's answer, not argued with.

*Fails open, deliberately.*  An unset or wholly blank allowlist settles nothing
and every request passes through with its ``Host`` untouched, which is exactly
today's behaviour.  That is what lets local development, Expo, LAN addresses and
the loopback DAST harness keep working with no configuration at all, and it is
why turning this on is an operator's decision rather than a deploy-breaking
default.  The boot-time check refuses a *malformed* value on every environment
and merely announces an *absent* one in production, because an absent value
degrades to the status quo while a malformed one silently disarms the control.

*No default from the platform's own domain.*  Defaulting to something like
``RAILWAY_PUBLIC_DOMAIN`` would look helpful and would silently rewrite the
authority of a deploy serving a custom domain alongside the platform one.
"""

from __future__ import annotations

import os
import re

# Comma-separated hostnames, each with an optional port, that this app answers
# as.  The first usable entry is the canonical one every other authority is
# settled onto.
ALLOWED_HOSTS_ENV_VAR = "ALLOWED_HOSTS"

# Where the middleware records the authority a request arrived with, on the
# requests whose authority it replaced.  Absent from every other scope, so its
# mere presence is the signal that a settle happened.
ORIGINAL_HOST_SCOPE_KEY = "adepthood.original_host"

_ENTRY_SEPARATOR = ","
_PORT_SEPARATOR = ":"

# A bare authority: a hostname of alphanumerics, dots and hyphens that neither
# starts nor ends with a separator, plus an optional numeric port.  Matched
# against an already-lowercased candidate, which is why it carries no uppercase
# range.  Everything an operator might reach for that is not an authority fails
# it: a wildcard (``*.example.com``), a URL (``https://api.example.com``), a
# path (``api.example.com/v1``), userinfo (``user@api.example.com``), a
# bracketed IPv6 literal, an interior space, and the empty string.
#
# Wildcards are refused rather than supported.  A wildcard names a set of
# authorities, and this module's whole job is to name the one authority a
# non-matching request is settled onto -- a set has no canonical member to
# substitute, so the feature would have no coherent answer to give.
_AUTHORITY_PATTERN = re.compile(r"^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$")


def usable_host(entry: str) -> str | None:
    """Return the authority ``entry`` names, canonicalised, or None when it names none.

    The single judgement of what counts as an authority, shared by the runtime
    and the boot-time check so the two cannot reach different conclusions about
    the same string: whatever the runtime would discard is exactly what boot
    refuses.  Surrounding whitespace is padding rather than a typo, and case is
    not part of a hostname's identity, so both are normalised away.
    """
    candidate = entry.strip().lower()
    return candidate if _AUTHORITY_PATTERN.match(candidate) else None


def _hostname(authority: str) -> str:
    """Return the host half of ``authority``, dropping any port."""
    return authority.partition(_PORT_SEPARATOR)[0]


def _configured_entries() -> list[str]:
    """Read the raw, unsplit allowlist entries from the environment at call time.

    Reading per call means changing the allowlist needs no restart, matching
    ``client_ip._trusted_networks``.  It is also what makes this testable at
    all: the middleware stack is built once at import, so a test that could only
    influence the allowlist at construction time could never configure it.
    """
    return os.getenv(ALLOWED_HOSTS_ENV_VAR, "").split(_ENTRY_SEPARATOR)


def allowed_hosts() -> list[str]:
    """Return the authorities this app answers as, in the operator's own order.

    Entries that name no authority are dropped rather than defaulted, so a value
    the boot check refused cannot half-arm the control if it is set on a running
    process: with nothing usable left the list is empty and the middleware
    settles nothing, which is the status-quo behaviour rather than a new one.
    """
    parsed = (usable_host(entry) for entry in _configured_entries())
    return [host for host in parsed if host is not None]


def unusable_host_entries() -> list[str]:
    """Return the configured entries that name no authority, verbatim.

    Exists so boot -- the one caller that can afford to speak -- can quote back
    what the per-request path silently discards.  The entries come back exactly
    as typed, because the operator has to recognise their own mistake in the
    message; a stray character is the whole bug.  Blank entries are not
    mistakes: a trailing separator or a doubled comma is ordinary list padding,
    tolerated the same way ``client_ip._split_entries`` tolerates it.
    """
    return [
        entry for entry in _configured_entries() if entry.strip() and usable_host(entry) is None
    ]


def settled_host(inbound: str) -> str | None:
    """Return the authority to put on the request, or None to leave it untouched.

    None means one of two very different things that call for the same action:
    the allowlist names nobody, so this app has no opinion about authority; or
    the request already names an allowlisted one, so it needs no correction.

    Matching ignores the port on both sides, so an operator who writes
    ``api.example.com`` covers that host on whatever port the ingress presents
    it on, and does not have to enumerate them.  The substitution, by contrast,
    is the entry *verbatim* -- an operator who wrote ``localhost:8000`` meant the
    port to appear in the URLs the app mints, and dropping it would produce a
    ``Location`` pointing at a port nothing is listening on.

    An empty ``inbound`` names no authority and therefore matches nothing.  That
    is the arm a request with no ``Host`` header at all takes, and it must:
    Starlette falls back to ``scope["server"]`` when the header is missing, which
    would leak the container's internal socket address into the ``Location``.
    """
    allowed = allowed_hosts()
    if not allowed:
        return None
    if _hostname(inbound.strip().lower()) in {_hostname(host) for host in allowed}:
        return None
    return allowed[0]
