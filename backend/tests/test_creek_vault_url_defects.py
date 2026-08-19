"""What a configured Creek Vault URL that cannot be used does to a journal save.

``CREEK_VAULT_URL`` is read by a *per-request* dependency, so whatever the vault
seam decides about it, it decides on the writer's request path. That is the whole
weight behind these tests: a URL the transport refuses to bind a credential to
must not become a 500 on ``POST /journal/``, because the entry the writer just
typed exists nowhere else yet. Replication into a vault is documented
best-effort -- a failed one is dropped, not queued, and the local Postgres row is
the system of record -- so skipping the optional half is the honest answer to a
URL nobody can use. Skipping it *quietly* is not, which is why every degrade here
is paired with exactly one WARNING.

Three layers, pinned in that order.

The classifier :func:`unusable_creek_vault_url` names the defect in a closed
four-member vocabulary, and the *order* it decides in is load-bearing rather than
incidental: ``urlsplit`` puts a username in the scheme slot for
``user:pass@host``, and reports no host at all for ``https://``, so a finding may
only name a scheme once userinfo has been ruled out and a host is known to exist.
Every detail string a finding carries is either static, one of this module's own
component names, or the scheme-and-host wording the transport check already used
-- never anything else drawn from the configured value, because this finding
reaches a log and one of the components it can name is a credential.

The adapter :class:`HttpCreekVaultClient` still fails closed on every one of
those defects. Constructing it with a URL nobody validated is a programming
error, and the credential must never reach a suspect endpoint, so the refusal
stays a raise.

The factory :func:`build_creek_vault_client` -- the one reached per request --
degrades instead, and the end-to-end cases at the bottom are the point of the
whole file: the entry is saved, the response is not a 500, no request leaves the
process, and the API key appears in no record.
"""

from __future__ import annotations

import dataclasses
import logging
import traceback
from collections.abc import AsyncGenerator
from http import HTTPStatus

import httpx
import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from domain.creek_vault import CONTRACT_VERSION
from models.journal_entry import JournalEntry
from services.creek_vault_client import (
    _RETIRED_PROTOCOL_EVENT,
    _UNKNOWN_PROTOCOL_EVENT,
    CONTRACT_MINOR,
    HttpCreekVaultClient,
    LocalFallbackCreekVaultClient,
    VaultUrlDefect,
    VaultUrlFinding,
    _VaultHttpPool,
    build_creek_vault_client,
    unusable_creek_vault_url,
)

_URL_ENV_VAR = "CREEK_VAULT_URL"
_KEY_ENV_VAR = "CREEK_VAULT_API_KEY"
_PROTOCOL_ENV_VAR = "CREEK_VAULT_PROTOCOL"
_OWNER_ENV_VAR = "CREEK_VAULT_OWNER_USER_ID"

_POOL_ATTR = "services.creek_vault_client._VAULT_HTTP_POOL"

_VAULT_URL = "https://vault.example.test"

# The bearer credential, spelled so that finding it anywhere is unambiguous. It
# is the reason the transport refuses an unusable URL at all, so no refusal, log
# record, or degrade may ever repeat it.
_SENTINEL_KEY = "SENTINEL_VAULT_KEY_DO_NOT_LEAK"  # pragma: allowlist secret

# Userinfo smuggled into the configured URL. It is itself a credential -- httpx
# renders it unmasked in ``str(url)`` and would derive Basic auth from it -- so
# neither half may reach a message, a structured field, or a finding's detail.
_SENTINEL_USER = "SENTINELUSER"
_SENTINEL_PASSWORD = "SENTINELPASSWORD"  # pragma: allowlist secret

_USERINFO_URL = f"https://{_SENTINEL_USER}:{_SENTINEL_PASSWORD}@vault.example.test"

# The same userinfo with no host behind it, and with a plaintext scheme in front
# of it: the two URLs that decide whether userinfo is ruled out before anything
# else is reported.
_USERINFO_NO_HOST_URL = f"https://{_SENTINEL_USER}:{_SENTINEL_PASSWORD}@"
_USERINFO_PLAINTEXT_URL = f"http://{_SENTINEL_USER}:{_SENTINEL_PASSWORD}@vault.example.test"

# Userinfo written without the ``//`` that would make it userinfo at all.
# ``urlsplit`` reads the username as the *scheme* here and finds no host, which
# is exactly why a finding may not name a scheme until a host is known.
_SCHEME_SLOT_USERINFO_URL = f"{_SENTINEL_USER}:{_SENTINEL_PASSWORD}@vault.example.test"

# An unterminated IPv6 literal: ``urlsplit`` raises ``ValueError`` on it, so it
# escapes ahead of any validator that assumes a parse succeeded.
_UNPARSEABLE_URL = "https://[::1"
_UNPARSEABLE_WITH_USERINFO_URL = f"https://{_SENTINEL_USER}:{_SENTINEL_PASSWORD}@[::1"

# The unparseable URL whose refusal ``urlsplit`` describes by quoting the entire
# netloc back at the caller -- userinfo included, which is to say the vault
# password. U+2100 is one of the codepoints NFKC normalization rewrites, and
# rewriting a netloc is exactly what that check refuses to let a URL do; it is
# written as an escape so this file stays ASCII. This is the reason the parser's
# own exception may never be re-raised from, chained to, or rendered.
_NETLOC_ECHOING_URL = f"https://{_SENTINEL_USER}:{_SENTINEL_PASSWORD}@\u2100vault.example.test"

# The whole taxonomy, one case per way a configured URL can be unusable. Shared
# by the classifier, the adapter, and the factory so all three are asserted to
# agree about what a given string is -- a disagreement between them is how a URL
# ends up refused in one layer and accepted in another.
_DEFECTIVE_URLS = [
    pytest.param(_UNPARSEABLE_URL, VaultUrlDefect.UNPARSEABLE, id="unparseable_ipv6_literal"),
    pytest.param(_NETLOC_ECHOING_URL, VaultUrlDefect.UNPARSEABLE, id="unparseable_netloc"),
    pytest.param("https://", VaultUrlDefect.MALFORMED, id="scheme_but_no_host"),
    pytest.param("vault.example.test", VaultUrlDefect.MALFORMED, id="bare_hostname"),
    pytest.param(_USERINFO_URL, VaultUrlDefect.FORBIDDEN_COMPONENTS, id="userinfo"),
    pytest.param(f"{_VAULT_URL}?", VaultUrlDefect.FORBIDDEN_COMPONENTS, id="empty_query"),
    pytest.param(f"{_VAULT_URL}#", VaultUrlDefect.FORBIDDEN_COMPONENTS, id="empty_fragment"),
    pytest.param(f"{_VAULT_URL}/api?tenant=1", VaultUrlDefect.FORBIDDEN_COMPONENTS, id="query"),
    pytest.param("http://vault.example.test", VaultUrlDefect.INSECURE_TRANSPORT, id="plaintext"),
    pytest.param("ftp://vault.example.test", VaultUrlDefect.INSECURE_TRANSPORT, id="wrong_scheme"),
]

# Every detail a MALFORMED finding may carry: which components are missing, and
# nothing else. A closed vocabulary rather than a formatted value, because the
# string an operator mistyped is the one thing this finding must not repeat.
_MALFORMED_DETAILS = frozenset({"scheme", "host", "scheme, host"})

# Values the runtime honours, so the classifier has nothing to report about them.
# The loopback plaintext cases are the developer exemption the transport check
# has always made; the path-prefix and trailing-slash cases are legal shapes a
# careless "tidy the URL" refactor would start rejecting.
_USABLE_URLS = [
    _VAULT_URL,
    f"{_VAULT_URL}/",
    f"{_VAULT_URL}/vault/",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "http://[::1]:8000",
]

# Unset, empty, and whitespace-only: three spellings of "I configured no vault".
_ABSENT_URLS = [None, "", "   "]

_SIGNUP_PASSWORD = "secret12345"  # pragma: allowlist secret

_ENTRY_BODY = "The willow bent without breaking, and I noticed that I did too."

# One capability document, healthy: any request reaching the recording transport
# below is a request that should never have been sent, and answering it happily
# keeps the test's failure the fact that it happened rather than a transport
# error somewhere downstream of it.
_CAPABILITY_PAYLOAD: dict[str, object] = {
    # Creek's real document shape: availability nested, capabilities by their
    # published wire names.
    "vault": {"available": True},
    "capabilities": ["journal-upsert"],
    "contract_version": CONTRACT_VERSION,
    "contract_minor": CONTRACT_MINOR,
    "supported_contract_minors": [CONTRACT_MINOR],
    "ontology_version": "aptitude-wavelength/2026-05-23",
    "attestation": None,
}


class _OfflineVault:
    """The vault's whole outside world: what was configured, and what ever left the process.

    One object because the two are one question. "Was a request made?" is only
    meaningful against a particular configuration, and a test that had to reach
    for the environment and the transport separately would be free to assert the
    second while forgetting the first.
    """

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Start with nothing built, nothing served, and nothing configured."""
        self._monkeypatch = monkeypatch
        self.builds = 0
        self.requests: list[httpx.Request] = []

    def __call__(self) -> httpx.AsyncClient:
        """Build one in-memory client and count the build."""
        self.builds += 1
        return httpx.AsyncClient(transport=httpx.MockTransport(self._serve))

    def _serve(self, request: httpx.Request) -> httpx.Response:
        """Record the request and answer with a healthy capability document."""
        self.requests.append(request)
        return httpx.Response(HTTPStatus.OK, json=_CAPABILITY_PAYLOAD)

    def configure(self, url: str, owner_id: int | None = None) -> None:
        """Point the deployment at ``url``, optionally binding it to one user."""
        self._monkeypatch.setenv(_URL_ENV_VAR, url)
        if owner_id is not None:
            self._monkeypatch.setenv(_OWNER_ENV_VAR, str(owner_id))


@pytest_asyncio.fixture
async def offline_vault(monkeypatch: pytest.MonkeyPatch) -> AsyncGenerator[_OfflineVault, None]:
    """Replace the shared vault HTTP pool with one that records instead of connecting."""
    vault = _OfflineVault(monkeypatch)
    pool = _VaultHttpPool(build=vault)
    monkeypatch.setattr(_POOL_ATTR, pool)
    yield vault
    await pool.aclose()


@pytest.fixture
def configured_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """Bind the sentinel credential and clear the protocol selector.

    The selector is cleared rather than set so a stale value in a developer's own
    environment cannot degrade the client out from under a test that is asserting
    what the *URL* check does.
    """
    monkeypatch.setenv(_KEY_ENV_VAR, _SENTINEL_KEY)
    monkeypatch.delenv(_PROTOCOL_ENV_VAR, raising=False)


def _rendered_values(record: logging.LogRecord) -> list[str]:
    """Render every string one record could carry: its message plus each of its fields."""
    return [record.getMessage(), *[str(value) for value in record.__dict__.values()]]


def _finding_for(url: str, monkeypatch: pytest.MonkeyPatch) -> VaultUrlFinding:
    """Configure ``url`` and return the finding the classifier reports for it."""
    monkeypatch.setenv(_URL_ENV_VAR, url)
    finding = unusable_creek_vault_url()
    assert finding is not None, f"{url!r} must be reported as unusable"
    return finding


def _degrade_record(
    url: str, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> logging.LogRecord:
    """Build a client from ``url`` and return the single WARNING the factory emitted."""
    monkeypatch.setenv(_URL_ENV_VAR, url)
    caplog.set_level(logging.WARNING)

    client = build_creek_vault_client()

    assert isinstance(client, LocalFallbackCreekVaultClient)
    assert len(caplog.records) == 1
    return caplog.records[0]


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    """Sign up a fresh user and return its auth header and DB-assigned id."""
    response = await client.post(
        "/auth/signup",
        json={"email": f"{username}@example.com", "password": _SIGNUP_PASSWORD},
    )
    assert response.status_code == HTTPStatus.OK
    data = response.json()
    return {"Authorization": f"Bearer {data['token']}"}, int(data["user_id"])


def test_the_defect_vocabulary_is_closed_and_its_wire_values_are_stable() -> None:
    """Four defects, spelled the way a dashboard and an operator will read them back.

    The values travel in a structured log field, so they are part of the seam's
    contract with whoever is grepping: renaming one silently retires somebody's
    filter. Four and only four, because the classifier's whole job is to answer
    "which of these" -- a fifth member added without a classification rule would
    be a defect nothing can ever report.

    The second assertion is about the *rendering*, not the member: a structured
    log field is written out through ``str``, and only a string enum renders as
    its own wire value there. A plain :class:`enum.Enum` would put
    ``VaultUrlDefect.MALFORMED`` in the log line instead, which is a different
    contract with a different grep.
    """
    assert [defect.value for defect in VaultUrlDefect] == [
        "unparseable",
        "forbidden_components",
        "malformed",
        "insecure_transport",
    ]
    assert str(VaultUrlDefect.MALFORMED) == "malformed"


def test_a_finding_is_an_immutable_pair_of_defect_and_detail() -> None:
    """The finding is a value, so two reads of one misconfiguration compare equal.

    Hashability is the observable half of frozen: a mutable dataclass with
    equality is unhashable, so a finding that can be put in a set is one nothing
    downstream can edit between the classifier and the log record it becomes.
    """
    assert tuple(field.name for field in dataclasses.fields(VaultUrlFinding)) == (
        "defect",
        "detail",
    )
    finding = VaultUrlFinding(defect=VaultUrlDefect.MALFORMED, detail="host")
    twin = VaultUrlFinding(defect=VaultUrlDefect.MALFORMED, detail="host")
    assert finding == twin
    assert len({finding, twin}) == 1


@pytest.mark.parametrize("url", _ABSENT_URLS)
def test_no_configured_url_is_nothing_to_report(
    url: str | None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A deployment that configured no vault is the supported normal case, not a fault.

    Blank counts as unset for the same reason the throttle-prefix check treats it
    that way: ``backend/.env.example`` ships vault variables present and empty, so
    reporting blank would fire on every stock boot and teach operators to ignore
    the finding that matters.
    """
    if url is None:
        monkeypatch.delenv(_URL_ENV_VAR, raising=False)
    else:
        monkeypatch.setenv(_URL_ENV_VAR, url)

    assert unusable_creek_vault_url() is None


@pytest.mark.parametrize("url", _USABLE_URLS)
def test_a_usable_url_is_nothing_to_report(url: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """Every shape the transport accepts stays silent, loopback plaintext included."""
    monkeypatch.setenv(_URL_ENV_VAR, url)

    assert unusable_creek_vault_url() is None


@pytest.mark.parametrize(("url", "defect"), _DEFECTIVE_URLS)
def test_every_unusable_url_is_classified_into_the_taxonomy(
    url: str, defect: VaultUrlDefect, monkeypatch: pytest.MonkeyPatch
) -> None:
    """One defect per URL, and the same answer whichever layer asks the question."""
    assert _finding_for(url, monkeypatch).defect is defect


def test_an_unparseable_url_says_only_that_it_is_unparseable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A URL ``urlsplit`` refuses is described by a static string and nothing else.

    There is no parse to draw a component name from, so the only honest detail is
    a constant -- and a constant is also the only *safe* detail, since anything
    derived from a string nobody could parse could be any part of it, credential
    included. Two different unparseable URLs therefore produce the identical
    finding, which is the assertion a "helpful" detail would break.
    """
    finding = _finding_for(_UNPARSEABLE_URL, monkeypatch)
    with_userinfo = _finding_for(_UNPARSEABLE_WITH_USERINFO_URL, monkeypatch)

    assert finding == with_userinfo
    for leaked in (_SENTINEL_USER, _SENTINEL_PASSWORD, "::1"):
        assert leaked not in finding.detail
        assert leaked not in with_userinfo.detail


@pytest.mark.parametrize(
    ("url", "detail"),
    [
        pytest.param(_USERINFO_URL, "userinfo", id="userinfo"),
        pytest.param(f"https://{_SENTINEL_USER}@vault.example.test", "userinfo", id="no_password"),
        pytest.param(f"{_VAULT_URL}?", "query", id="empty_query"),
        pytest.param(f"{_VAULT_URL}/api?tenant=1", "query", id="query"),
        pytest.param(f"{_VAULT_URL}#", "fragment", id="empty_fragment"),
        pytest.param(f"{_VAULT_URL}#anchor?tenant=1", "fragment", id="question_mark_in_fragment"),
    ],
)
def test_forbidden_components_are_named_and_never_quoted(
    url: str, detail: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The finding names which components are present, exactly as the transport already did.

    Component *names* and no values, because one of the names it can report --
    userinfo -- is a credential, and this detail is destined for a log line. The
    question-mark-inside-a-fragment case is the one where naming both components
    would send an operator hunting a second problem they do not have.
    """
    finding = _finding_for(url, monkeypatch)

    assert finding.defect is VaultUrlDefect.FORBIDDEN_COMPONENTS
    assert finding.detail == detail


@pytest.mark.parametrize(
    ("url", "detail"),
    [
        pytest.param("https://", "host", id="scheme_only"),
        pytest.param("https:///path", "host", id="scheme_and_path_no_host"),
        pytest.param("//vault.example.test", "scheme", id="host_only"),
        pytest.param("vault.example.test", "scheme, host", id="bare_hostname"),
    ],
)
def test_a_malformed_url_names_only_the_missing_components(
    url: str, detail: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Which components are missing, drawn from a closed vocabulary, and no part of the value.

    ``https://`` is the case that matters most: it parses, it carries the right
    scheme, and it names no host at all -- so a check that stopped at the scheme
    would accept a URL no request can ever be built for. The detail is a
    component name rather than a formatted value because a URL missing its scheme
    is precisely the one whose first token may be anything, credential included.
    """
    finding = _finding_for(url, monkeypatch)

    assert finding.defect is VaultUrlDefect.MALFORMED
    assert finding.detail == detail
    assert finding.detail in _MALFORMED_DETAILS


@pytest.mark.parametrize(
    ("url", "detail"),
    [
        pytest.param(
            "http://vault.example.test",
            "scheme 'http', host 'vault.example.test'",
            id="plaintext_remote",
        ),
        pytest.param(
            "ftp://vault.example.test",
            "scheme 'ftp', host 'vault.example.test'",
            id="scheme_nobody_speaks",
        ),
    ],
)
def test_insecure_transport_keeps_the_wording_the_transport_check_already_used(
    url: str, detail: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A parsed scheme and host are safe to quote, and are what an operator needs to see.

    Safe only because the three earlier classifications have run: userinfo is
    ruled out, so the scheme is a scheme rather than somebody's username, and a
    host is known to exist. This is the one detail that quotes the configured
    value at all, and it is the wording the raise has always carried.
    """
    finding = _finding_for(url, monkeypatch)

    assert finding.defect is VaultUrlDefect.INSECURE_TRANSPORT
    assert finding.detail == detail


def test_userinfo_is_ruled_out_before_anything_derived_from_a_parse_is_reported(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Userinfo outranks both malformation and transport, and never appears in the finding.

    The ordering is the safety property, not a preference. ``urlsplit`` puts a
    username in the scheme slot when the ``//`` is missing, so any finding that
    quotes a scheme before userinfo has been excluded can quote a credential
    instead. A userinfo URL with no host and a userinfo URL over plaintext are
    both answerable in two ways; the answer that mentions no value is the one
    that must win.
    """
    no_host = _finding_for(_USERINFO_NO_HOST_URL, monkeypatch)
    plaintext = _finding_for(_USERINFO_PLAINTEXT_URL, monkeypatch)

    assert no_host.defect is VaultUrlDefect.FORBIDDEN_COMPONENTS
    assert plaintext.defect is VaultUrlDefect.FORBIDDEN_COMPONENTS
    for finding in (no_host, plaintext):
        assert finding.detail == "userinfo"
        assert _SENTINEL_USER not in finding.detail
        assert _SENTINEL_PASSWORD not in finding.detail


def test_a_username_in_the_scheme_slot_is_never_reported_as_a_scheme(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``user:pass@host`` parses as a scheme named after the user, and must not be quoted.

    Nothing marks this string as userinfo once ``urlsplit`` is done with it: with
    no ``//`` there is no netloc, so the username and password halves come back
    empty and the credential sits in the scheme. Reporting it as a missing host
    is both true and silent about the value, which is the only combination that
    is safe here.
    """
    finding = _finding_for(_SCHEME_SLOT_USERINFO_URL, monkeypatch)

    assert finding.defect is VaultUrlDefect.MALFORMED
    assert finding.detail == "host"
    assert _SENTINEL_USER not in finding.detail
    assert _SENTINEL_PASSWORD not in finding.detail


def test_a_missing_host_outranks_an_unusable_scheme(monkeypatch: pytest.MonkeyPatch) -> None:
    """No host means no request, whatever the scheme says, so malformation is reported first."""
    finding = _finding_for("ftp://", monkeypatch)

    assert finding.defect is VaultUrlDefect.MALFORMED
    assert finding.detail == "host"


@pytest.mark.parametrize(("url", "defect"), _DEFECTIVE_URLS)
def test_constructing_the_adapter_directly_still_fails_closed(
    url: str, defect: VaultUrlDefect, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Handing the transport an unusable URL is a programming error and stays loud.

    The factory degrades because it runs on the writer's request path; this
    constructor does not, and a caller reaching it with a URL nobody classified
    would be binding the bearer credential to an endpoint no check approved. So
    the refusal stays a raise, it names the variable an operator has to go and
    fix, it repeats the finding's detail and nothing more, and the credential it
    was called with never reaches the message.
    """
    finding = _finding_for(url, monkeypatch)

    with pytest.raises(ValueError, match=_URL_ENV_VAR) as exc_info:
        HttpCreekVaultClient(url, _SENTINEL_KEY)

    message = str(exc_info.value)
    assert finding.defect is defect
    assert finding.detail in message
    assert _SENTINEL_KEY not in message
    assert _SENTINEL_USER not in message
    assert _SENTINEL_PASSWORD not in message


def test_the_forbidden_component_refusal_keeps_its_exact_message() -> None:
    """The message operators and runbooks already know is preserved verbatim."""
    with pytest.raises(ValueError, match=_URL_ENV_VAR) as exc_info:
        HttpCreekVaultClient(_USERINFO_URL, _SENTINEL_KEY)

    assert str(exc_info.value) == "CREEK_VAULT_URL must not carry these URL components: userinfo"


def test_the_insecure_transport_refusal_keeps_its_exact_message() -> None:
    """The plaintext-remote refusal is unchanged, wording and all."""
    with pytest.raises(ValueError, match=_URL_ENV_VAR) as exc_info:
        HttpCreekVaultClient("http://vault.example.test", _SENTINEL_KEY)

    assert str(exc_info.value) == (
        "CREEK_VAULT_URL must use https for a non-loopback host "
        "(scheme 'http', host 'vault.example.test')"
    )


def test_the_parsers_own_complaint_never_rides_along_with_the_refusal() -> None:
    """A rejected URL is described in our words, and the parser's are dropped, chain included.

    ``urlsplit`` does not merely fail on a netloc it cannot normalize -- it quotes
    the whole netloc back in the message, and a netloc includes userinfo. So the
    parser's own exception is the one object in this seam that is *guaranteed* to
    hold a credential when it exists, and a plain ``raise`` inside its ``except``
    would hand it to Python as ``__context__``, where the traceback renders it
    into whatever log caught the request. Clearing the message is not enough;
    the chain has to be cut, which is what makes this an assertion about
    ``__cause__`` and ``__context__`` rather than about wording.

    The whole formatted traceback is searched rather than just the message,
    because that rendering is what a 500 handler and an ``exception()`` call both
    actually write down.
    """
    with pytest.raises(ValueError, match=_URL_ENV_VAR) as exc_info:
        HttpCreekVaultClient(_NETLOC_ECHOING_URL, _SENTINEL_KEY)

    error = exc_info.value
    assert error.__cause__ is None
    assert error.__context__ is None
    rendered = "".join(traceback.format_exception(error))
    for leaked in (_SENTINEL_USER, _SENTINEL_PASSWORD, _SENTINEL_KEY):
        assert leaked not in rendered


@pytest.mark.usefixtures("configured_key")
@pytest.mark.parametrize(("url", "defect"), _DEFECTIVE_URLS)
def test_the_factory_degrades_an_unusable_url_instead_of_raising(
    url: str,
    defect: VaultUrlDefect,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A URL nobody can use costs the deployment its vault, never the writer their entry.

    This factory is reached from a per-request dependency, so a raise here means
    the journal handler's body never runs and the entry exists nowhere. The vault
    is best-effort by construction -- a dropped replication is dropped, and
    Postgres is the system of record -- so skipping the optional half is the
    honest answer. What makes it honest rather than negligent is the record: one
    WARNING, naming the variable, carrying the defect and the detail as
    structured fields a dashboard can group on, and repeating neither the
    configured value nor the credential.
    """
    record = _degrade_record(url, monkeypatch, caplog)

    assert record.levelno == logging.WARNING
    message = record.getMessage()
    assert _URL_ENV_VAR in message
    assert "unset" in message
    assert record.__dict__["env_var"] == _URL_ENV_VAR
    assert record.__dict__["url_defect"] == defect.value
    assert record.__dict__["url_detail"] == _finding_for(url, monkeypatch).detail
    for rendered in _rendered_values(record):
        assert _SENTINEL_KEY not in rendered


@pytest.mark.usefixtures("configured_key")
def test_the_degrade_record_repeats_neither_the_credential_nor_the_userinfo(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Two credentials are in play at once here, and neither may reach a log.

    The bearer key is what the URL check exists to protect; the userinfo is a
    second credential the operator put in the URL itself, which httpx would
    render unmasked given the chance. The configured string is swept as a whole
    as well, because a record that echoed the URL verbatim would carry the
    userinfo inside it. Every value is checked, not just the message: a
    structured field is logged exactly as faithfully as a formatted one.
    """
    record = _degrade_record(_USERINFO_URL, monkeypatch, caplog)

    for rendered in _rendered_values(record):
        assert _SENTINEL_KEY not in rendered
        assert _SENTINEL_USER not in rendered
        assert _SENTINEL_PASSWORD not in rendered
        assert _USERINFO_URL not in rendered


@pytest.mark.usefixtures("configured_key")
def test_the_url_degrade_is_its_own_news(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """A broken URL is a different fault from a protocol selector nobody honours.

    Three degrades now land a deployment on the local fallback, and an operator
    reading one of them has to be able to tell which variable to go and look at.
    A message shared with either protocol record would send them to
    ``CREEK_VAULT_PROTOCOL`` for a typo that is in ``CREEK_VAULT_URL``.
    """
    message = _degrade_record("http://vault.example.test", monkeypatch, caplog).getMessage()

    assert message != _RETIRED_PROTOCOL_EVENT
    assert message != _UNKNOWN_PROTOCOL_EVENT


@pytest.mark.usefixtures("configured_key")
@pytest.mark.parametrize(
    ("protocol", "event"),
    [
        pytest.param("mcp", _RETIRED_PROTOCOL_EVENT, id="retired_protocol"),
        pytest.param("grpc", _UNKNOWN_PROTOCOL_EVENT, id="unrecognized_protocol"),
    ],
)
def test_an_unhonoured_protocol_is_reported_before_the_url_is_judged(
    protocol: str,
    event: str,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A deployment that will not use the URL at all has no business complaining about it.

    With the selector already refusing the transport, the URL is never read, so
    reporting a defect in it would be reporting a fault that has no consequence
    -- and would double the record count for one misconfiguration. The order of
    the checks is what keeps the loudest thing said the true one.
    """
    monkeypatch.setenv(_PROTOCOL_ENV_VAR, protocol)
    monkeypatch.setenv(_URL_ENV_VAR, "http://vault.example.test")
    caplog.set_level(logging.WARNING)

    client = build_creek_vault_client()

    assert isinstance(client, LocalFallbackCreekVaultClient)
    assert len(caplog.records) == 1
    assert caplog.records[0].getMessage() == event


@pytest.mark.usefixtures("configured_key")
@pytest.mark.parametrize("url", _ABSENT_URLS)
def test_an_unconfigured_deployment_still_gets_the_local_fallback(
    url: str | None, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """No vault configured is not a defect, and the new check must not make it one.

    Silently, too: running with no vault is this product's supported floor, so a
    deployment that chose it must not be told off once per request for the
    choice.

    The whitespace-only case is the one worth spelling out, because it is the one
    place the two layers could have disagreed. Both read blank the same way --
    unset -- so an operator who left a stray space in an otherwise empty variable
    gets the same silence everywhere rather than nothing at boot, where they are
    looking, and a WARNING on every request, where it costs the most. What blank
    must never become is a raise: that would cost that operator every entry the
    deployment takes.
    """
    if url is None:
        monkeypatch.delenv(_URL_ENV_VAR, raising=False)
    else:
        monkeypatch.setenv(_URL_ENV_VAR, url)
    caplog.set_level(logging.WARNING)

    assert isinstance(build_creek_vault_client(), LocalFallbackCreekVaultClient)
    assert caplog.records == []


@pytest.mark.usefixtures("configured_key")
def test_a_defective_url_is_never_quietly_repaired(monkeypatch: pytest.MonkeyPatch) -> None:
    """A trailing ``?`` is refused, not trimmed: the operator's configuration is theirs.

    Reconstructing a URL from its parsed parts would close the hole by editing
    something nobody wrote, and the edit would be invisible -- a deployment
    replicating to an endpoint subtly different from the configured one is worse
    than a deployment replicating nowhere and saying so.
    """
    monkeypatch.setenv(_URL_ENV_VAR, f"{_VAULT_URL}?")

    assert isinstance(build_creek_vault_client(), LocalFallbackCreekVaultClient)


@pytest.mark.usefixtures("configured_key")
@pytest.mark.parametrize(
    "url",
    [
        pytest.param(f"{_VAULT_URL}/Vault/Prefix", id="no_trailing_slash"),
        pytest.param(f"{_VAULT_URL}/Vault/Prefix/", id="trailing_slash"),
    ],
)
@pytest.mark.asyncio
async def test_a_usable_url_reaches_the_transport_byte_for_byte(
    url: str,
    offline_vault: _OfflineVault,
) -> None:
    """The only edit a usable URL receives is the documented trailing-slash strip.

    Case, path prefix, and everything else survive intact. Classifying a URL
    means reading it, and a reader is one refactor away from becoming a rewriter
    -- so the request that actually leaves is asserted against the configured
    string rather than against a re-derived one.
    """
    offline_vault.configure(url)

    client = build_creek_vault_client()
    assert isinstance(client, HttpCreekVaultClient)
    assert (await client.handshake()).available is True

    assert len(offline_vault.requests) == 1
    assert str(offline_vault.requests[0].url) == f"{_VAULT_URL}/Vault/Prefix/v1/capabilities"


@pytest.mark.parametrize(
    "case",
    [
        pytest.param(("https://", VaultUrlDefect.MALFORMED), id="malformed"),
        pytest.param(
            ("http://vault.example.test", VaultUrlDefect.INSECURE_TRANSPORT), id="insecure"
        ),
    ],
)
@pytest.mark.usefixtures("configured_key")
@pytest.mark.asyncio
async def test_the_writer_keeps_their_entry_when_the_vault_url_is_unusable(
    case: tuple[str, VaultUrlDefect],
    async_client: AsyncClient,
    db_session: AsyncSession,
    caplog: pytest.LogCaptureFixture,
    offline_vault: _OfflineVault,
) -> None:
    """The whole point, end to end: a typo in one variable costs the vault, not the entry.

    Driven through the real app, with the vault bound to the user doing the
    writing, because that is the only configuration in which the factory is
    reached at all -- and the configuration in which a raise used to turn every
    save into a 500 with the writer's words nowhere on disk.

    Four things have to hold at once. The save succeeds and the entry reads back,
    since Postgres is the system of record and always was. Its ``vault_ref`` is
    empty rather than optimistic, because nothing was replicated and a ref for a
    fragment no vault holds would be a lie the read path later trips over. Not
    one request leaves the process, since the credential must never be bound to
    a URL that failed its check -- that is what the refusal was always for. And
    the credential appears in no record emitted along the way, message or field.
    """
    url, defect = case
    caplog.set_level(logging.DEBUG)
    headers, user_id = await _signup(async_client, "vault_url_defect")
    offline_vault.configure(url, owner_id=user_id)

    created = await async_client.post(
        "/journal/",
        json={"message": _ENTRY_BODY, "classification": "personal"},
        headers=headers,
    )

    assert created.status_code == HTTPStatus.CREATED
    entry_id = int(created.json()["id"])

    fetched = await async_client.get(f"/journal/{entry_id}", headers=headers)
    assert fetched.status_code == HTTPStatus.OK
    assert fetched.json()["message"] == _ENTRY_BODY

    stored = await db_session.get(JournalEntry, entry_id)
    assert stored is not None
    assert stored.vault_ref is None

    assert offline_vault.builds == 0, "an unusable URL must not open a connection to anything"
    assert offline_vault.requests == []

    defects = [record.__dict__.get("url_defect") for record in caplog.records]
    assert defect.value in defects, "the degrade must still be announced on the request path"
    for record in caplog.records:
        for rendered in _rendered_values(record):
            assert _SENTINEL_KEY not in rendered
