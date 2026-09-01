"""Drift guards on the production origins ``DEPLOYMENT.md`` publishes.

A deployment guide is read at exactly one moment: something is wrong, or
something has just shipped, and the operator wants to know whether the thing is
up. Every hostname in it is therefore load-bearing in a way ordinary prose is
not -- a wrong one does not read as wrong. It reads as an outage, because a
request to a host that was never provisioned fails the same way a request to a
backend that refused to boot does.

This guide had two such names. ``api.adepthood.com`` and ``app.adepthood.com``
were stated as this deployment's origins although ``adepthood.com`` has no DNS
records at all and never had any, while the origin the API is really served
from appeared nowhere in the repository. The rule the project applies to that
shape is to delete the claim rather than build a deployment to justify it, so
the names are gone and one dated block now states what is actually served.

Four things are pinned here, and each one is pinned because the platform makes
the obvious check useless.

*The names must not come back.* A deny list over the whole file, not over a
section, because the two names had spread to five lines across four sections --
a diagram, a custom-domain step, and two variable tables -- and a guard scoped
to any one of them would have watched the claim reappear somewhere else.

*One block, and only one, answers "what are the origins".* The old file stated
the web origin six times and the API origin zero times, and two of those six
disagreed with each other seventeen lines apart in the same table. Duplication
of half the answer beside total absence of the other half is how a wrong host
survives unread. The table is required to carry both roles with a verification
date, since a Railway-generated origin changes if its service is recreated and
an undated origin cannot be told from a stale one.

*Resolution is not evidence, and neither is a 200.* Both of the checks an
operator reaches for first are actively misleading on this stack, so the guide
has to say so and the saying has to be pinned. ``*.up.railway.app`` is wildcard
DNS -- an invented name under it resolves exactly like a real service -- so
``dig`` proves nothing in either direction. And the web origin's nginx serves
``index.html`` for unmatched paths, which makes ``GET /health`` on it answer
``200 text/html``: a status-code-only check passes against a host that has no
health endpoint at all.

*The split probes are documented.* ``/health/live`` and ``/health/ready`` exist
in ``main.py`` and were absent from this guide entirely, which left the combined
legacy ``/health`` as the only probe an operator could find.

The origins themselves are asserted only for *shape* -- ``https``, host, and
nothing after it -- which is the form ``APP_BASE_URL`` and
``EXPO_PUBLIC_API_BASE_URL`` both require. That is the honest limit of an
offline guard: it cannot tell a live host from a dead one, only a well-formed
origin from a malformed one and a known-dead name from an unrecognised one.
Liveness is a network fact, and a test that reached the network to check it
would fail on an aeroplane and pass on a deleted service that someone else's
wildcard still answers for.

Every assertion here reads ``DEPLOYMENT.md`` off disk. No socket is opened, no
name is resolved, and nothing is imported from the application.

Both fixtures end their slice at the next markdown heading, so a fenced block
added inside either section whose content begins a line with ``##`` would cut
the slice short and fail a later assertion about text that is really there.
"""

from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import urlsplit

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[2]
_DEPLOYMENT_DOC = _REPO_ROOT / "DEPLOYMENT.md"

# Hosts under a domain with no DNS records whatsoever. They are not "not yet
# provisioned"; ``adepthood.com`` itself has no A record, so nothing under it
# has ever answered a request.
_UNPROVISIONED_HOSTS = ("api.adepthood.com", "app.adepthood.com")

# The block that states what this deployment actually serves from, and the
# pattern that ends it: the next heading at either level, since it is a
# subsection of ``Architecture``.
_ORIGINS_HEADING = "### Production origins"
_HEALTH_HEADING = "### Health check"
_NEXT_HEADING = re.compile(r"^###? ", re.MULTILINE)

# A row of the origins table: a role, a backticked https origin, and the date
# that origin was last verified against the running deployment.
_ORIGIN_ROW = re.compile(
    r"^\|\s*(?P<role>[^|]+?)\s*\|\s*`(?P<origin>https://[^`]+)`\s*"
    r"\|\s*(?P<verified>\d{4}-\d{2}-\d{2})\s*\|\s*$",
    re.MULTILINE,
)

# Both halves of the deployment have to be findable, or the block answers the
# question it exists for only half way -- which is the state that produced the
# defect this module guards.
_REQUIRED_ROLES = ("Web app", "API")

# The two checks that look like verification on this stack and are not: DNS
# resolution under Railway's wildcard, and a bare 200 from the web origin.
_WILDCARD_WARNING_TERMS = ("wildcard", "up.railway.app")
_SPA_FALLBACK_WARNING_TERMS = ("text/html", "index.html")

# The probes that exist in ``main.py`` and must be reachable from the guide,
# each beside the body it actually returns.
_HEALTH_SECTION_TERMS = (
    "/health/live",
    "/health/ready",
    '"alive"',
    '"ready"',
    "content_version",
)


def _section(heading: str) -> str:
    """Return the slice of the guide running from ``heading`` to the next one."""
    text = _DEPLOYMENT_DOC.read_text(encoding="utf-8")
    start = text.find(heading)
    assert start != -1, f"{_DEPLOYMENT_DOC} has no '{heading}' section"
    rest = text[start + len(heading) :]
    end = _NEXT_HEADING.search(rest)
    return rest[: end.start()] if end else rest


@pytest.fixture
def origins_section() -> str:
    """The ``Production origins`` block, heading to next heading."""
    return _section(_ORIGINS_HEADING)


@pytest.fixture
def health_section() -> str:
    """The ``Health check`` block, heading to next heading."""
    return _section(_HEALTH_HEADING)


@pytest.fixture
def documented_origins(origins_section: str) -> dict[str, str]:
    """Map each role in the origins table to the origin it publishes."""
    return {match["role"]: match["origin"] for match in _ORIGIN_ROW.finditer(origins_section)}


def test_deployment_doc_names_no_unprovisioned_adepthood_com_origin() -> None:
    """No line of the guide names a host that was never provisioned."""
    offenders = [
        (number, host)
        for number, line in enumerate(
            _DEPLOYMENT_DOC.read_text(encoding="utf-8").splitlines(), start=1
        )
        for host in _UNPROVISIONED_HOSTS
        if host in line
    ]
    assert not offenders, (
        f"DEPLOYMENT.md still names unprovisioned host(s) at {offenders}; "
        "adepthood.com has no A record, so each is a topology the deployment "
        "does not have -- the live origins are under 'Production origins'"
    )


def test_production_origins_table_records_both_roles(
    documented_origins: dict[str, str],
) -> None:
    """The origins table answers for the web app and the API, not just one."""
    missing = [role for role in _REQUIRED_ROLES if role not in documented_origins]
    assert not missing, (
        f"'{_ORIGINS_HEADING}' publishes no origin for {missing}; the API origin "
        "being absent from the repository is the defect this block exists to fix"
    )


def test_production_origins_table_dates_every_origin_it_publishes(
    origins_section: str,
) -> None:
    """Every published origin carries the date it was last verified."""
    rows = _ORIGIN_ROW.findall(origins_section)
    assert rows, (
        f"'{_ORIGINS_HEADING}' has no dated origin row; a Railway-generated "
        "origin changes when its service is recreated, so an undated origin "
        "cannot be distinguished from a stale one"
    )


def test_documented_origins_are_scheme_and_host_only(
    documented_origins: dict[str, str],
) -> None:
    """Each published origin has the shape the app's base-URL settings require."""
    malformed = {
        role: origin
        for role, origin in documented_origins.items()
        if not _is_bare_https_origin(origin)
    }
    assert not malformed, (
        f"{malformed} is not scheme-and-host-only; APP_BASE_URL and "
        "EXPO_PUBLIC_API_BASE_URL both take an https origin with no path, "
        "query, fragment or trailing slash"
    )


def _is_bare_https_origin(origin: str) -> bool:
    """Report whether ``origin`` is ``https://host`` and nothing more."""
    parts = urlsplit(origin)
    return (
        parts.scheme == "https"
        and bool(parts.netloc)
        and not parts.path
        and not parts.query
        and not parts.fragment
    )


def test_origins_block_warns_that_railway_dns_resolution_proves_nothing(
    origins_section: str,
) -> None:
    """The block says a resolving ``*.up.railway.app`` name is not a live deploy."""
    missing = [term for term in _WILDCARD_WARNING_TERMS if term not in origins_section]
    assert not missing, (
        f"'{_ORIGINS_HEADING}' omits {missing}; every name under "
        "up.railway.app resolves whether or not a service is attached, so an "
        "operator who checks with dig reads a wildcard answer as a live host"
    )


def test_origins_block_warns_that_a_200_is_not_a_health_response(
    origins_section: str,
) -> None:
    """The block says the web origin answers ``/health`` from the SPA fallback."""
    missing = [term for term in _SPA_FALLBACK_WARNING_TERMS if term not in origins_section]
    assert not missing, (
        f"'{_ORIGINS_HEADING}' omits {missing}; the web origin's nginx serves "
        "index.html for unmatched paths, so GET /health on it returns 200 "
        "text/html and a status-code-only check passes against no health "
        "endpoint at all"
    )


def test_health_section_documents_the_liveness_and_readiness_probes(
    health_section: str,
) -> None:
    """The health section names the split probes and the bodies they return."""
    missing = [term for term in _HEALTH_SECTION_TERMS if term not in health_section]
    assert not missing, (
        f"'{_HEALTH_HEADING}' omits {missing}; /health/live and /health/ready "
        "are served by the app, and a guide that names only the combined legacy "
        "probe leaves an operator unable to tell a wedged process from an "
        "unreachable database"
    )
