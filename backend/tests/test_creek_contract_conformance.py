"""Conformance of the Creek Vault client against Creek's own published bundle.

The fixtures under ``tests/fixtures/creek_v1/`` are Creek's ratified ``/v1``
contract bundle, vendored byte-for-byte from ``Geoffe-Ga/creek-vault`` at one
pinned commit. Every wire shape asserted below is read from those files. Nothing
here invents a payload: if a shape is not in the bundle it is not tested, and if
the bundle changes these tests change with it rather than the other way round.

Re-vendoring the bundle
-----------------------

1. Fetch each file from ``raw.githubusercontent.com`` at a **pinned commit sha**,
   never a branch. A branch would let the "pinned" copy move underneath the
   checksums that are the only thing making it a pin.
2. Verify every fetched file against Creek's own ``manifest.json``, which records
   a sha256 for the 45 files it covers -- it covers neither itself nor the
   hand-written ``README.md``.
3. Regenerate ``vendor.json`` with the drift script's ``snapshot`` subcommand and
   commit its output verbatim. ``tests/scripts/test_creek_contract_drift.py``
   asserts the committed sidecar is exactly what that command produces.
4. Re-run ``detect-secrets scan --baseline .secrets.baseline``: every digest
   changes, and a high-entropy hex string is precisely what that scanner flags.
5. Re-run this suite and the drift-script suite.
6. A change to Creek's ``contract_version`` is a **human decision**, not a
   mechanical update. Moving it means moving ``domain.creek_vault``'s
   ``CONTRACT_VERSION``, the pinned-version bullet in ADR 0004, and the contract
   document's version bullet together, in one reviewed change.

The strict-xfail tripwire
-------------------------

Two divergences separate today's client from Creek's ratified documents, and
both live in the handshake. The client reads a top-level ``available`` where
Creek nests ``vault.available``, and it maps advertised capability names through
``CreekCapability``, whose ``creek.*`` values share no member with Creek's
published names. Fixing either belongs to the client, not to this suite.

Until they are fixed, the ratified outcome is asserted under
``@pytest.mark.xfail(strict=True)``. Repo-wide ``xfail_strict`` means that
assertion executes on every run and becomes a **hard failure the moment it starts
passing** -- which is exactly when the client is fixed and the marker must be
deleted. That is the intent: the tripwire reports the divergence closing in the
same run that closes it. It is paired with plainly-asserted, today-green
observations of what the client actually does, so the current behaviour is
recorded rather than merely known.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from collections.abc import AsyncGenerator, Callable, Iterable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from http import HTTPStatus
from pathlib import Path

import httpx
import pytest
import pytest_asyncio

from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapability,
    CreekCapabilityUnsupportedError,
    CreekVaultAuthError,
    CreekVaultCareEscalationError,
    CreekVaultContractError,
    CreekVaultError,
    CreekVaultUnavailableError,
    VaultIngestAction,
    VaultIngestRequest,
    VaultIngestResult,
    VaultReflectionNote,
    VaultReflectionStatus,
    VaultTierCeiling,
)
from scripts.creek_contract_drift import BUNDLE_ROOT, EXIT_DRIFT, verify_local
from services.creek_vault_client import (
    _CAPABILITY_BY_WIRE_NAME,
    HandshakeDegradeReason,
    HttpCreekVaultClient,
)

MANIFEST_NAME = "manifest.json"
README_NAME = "README.md"
VENDOR_NAME = "vendor.json"
RETRY_POLICY_NAME = "retry-policy.json"

PINNED_REPO = "Geoffe-Ga/creek-vault"
PINNED_COMMIT = "879d9611cb4c3b5599578f39772b906c8c170e02"  # pragma: allowlist secret
PINNED_PATH = "docs/contracts/adepthood-v1"
ONTOLOGY_VERSION = "aptitude-wavelength/2026-05-23"

CREEK_MANIFEST_ENTRIES = 45
VENDORED_FILES = 47
EXAMPLE_CELLS = 28
CAPABILITY_COUNT = 4
STATE_COUNT = 7
UNREACHABLE_CELLS = 3
REACHABLE_CELLS = EXAMPLE_CELLS - UNREACHABLE_CELLS

_VAULT_URL = "https://vault.example.test"
_API_KEY = "creek-vault-conformance-key"  # pragma: allowlist secret
_CAPABILITIES_PATH = "/v1/capabilities"
_WHEEL_PATH = "/v1/wheel"
_REFLECTIONS_PATH = "/v1/reflections"

# The ceiling every reflections cell is driven at. Creek's own reflection
# examples echo ``personal`` in both tier fields, so accepting less would reject
# the ratified documents on a rule about adepthood rather than about them.
_REFLECT_CEILING = VaultTierCeiling.PERSONAL

# The marginalia kind Creek's ``pattern`` renders as. Written out rather than
# read back through the projection under test, which would accept whatever the
# table happened to say.
_PATTERN_MARGINALIA_KIND = "connection"

_ENTRY_ID = 7
_ENTRY_BODY = "a floor-level journal entry"
_CREATED_AT = datetime(2026, 7, 31, 6, 12, tzinfo=UTC)

# The vault-issued fragment id Creek's two ratified journal bodies answer with.
_FRAGMENT_ID = "frag-3f9a1c7e40b2"

# The longest string any vendored example carries is Creek's 201-character care
# message. A real journal body would not fit, which is what makes "no real
# writing was published in these fixtures" a checkable claim rather than a hope.
_MAX_EXAMPLE_STRING = 256

# Credential shapes that must appear in no vendored file. The key spellings are
# quoted so the README's prose about not carrying a token cannot match; the
# bearer prefix is what a captured header value would start with.
_CREDENTIAL_MARKERS = ('"api_key"', '"password"', '"token"', '"secret"', "Bearer ")

# The tier that must never egress, and the three fields it could travel in.
_FORBIDDEN_TIER = "intimate"
_TIER_FIELDS = ("tier", "tier_ceiling", "routed_tier")

# The two keys a journal body would travel under if one had been published.
_BODY_KEYS = ("content", "body")

# HAND-MAINTAINED TABLE. The seven per-state HTTP statuses appear only as prose in
# the bundle's hand-written README; no generated file carries them, so this
# restates that published state table and is the one mapping in this suite that is
# not read from machine-readable data. ``test_state_status_table_matches_the_manifest``
# keeps its key set honest against the manifest.
_STATUS_BY_STATE: Mapping[str, int] = {
    "success": HTTPStatus.OK,
    "empty": HTTPStatus.OK,
    "care-escalation": HTTPStatus.OK,
    "refusal": HTTPStatus.FORBIDDEN,
    "malformed-input": HTTPStatus.UNPROCESSABLE_ENTITY,
    "incompatible-version": HTTPStatus.CONFLICT,
    "unavailable-service": HTTPStatus.SERVICE_UNAVAILABLE,
}

# The states served at a non-200 status, derived from the table above rather than
# written out a second time, so the two can never disagree about which cells are
# errors.
_ERROR_STATES = frozenset(
    state for state, status in _STATUS_BY_STATE.items() if status != HTTPStatus.OK
)

# The client's own wire-name translation, imported rather than restated. It used
# to be duplicated here as scaffolding around two divergences -- the client read
# a top-level ``available`` Creek does not publish, and mapped advertised names
# through ``CreekCapability``, whose ``creek.*`` values share no member with
# Creek's published names. Both are fixed, so the fixture is served verbatim and
# this alias exists only so the guard below asserts against the SHIPPED table.
_CAPABILITY_BY_CREEK_NAME = _CAPABILITY_BY_WIRE_NAME

Handler = Callable[[httpx.Request], httpx.Response]
ClientFactory = Callable[[Handler], HttpCreekVaultClient]


@dataclass(frozen=True)
class _Cell:
    """One ``(capability, state)`` cell of Creek's published example matrix."""

    capability: str
    state: str
    path: str
    model: str


def _read_bytes(relative: str) -> bytes:
    """Return the raw bytes of one vendored bundle file."""
    return (BUNDLE_ROOT / relative).read_bytes()


def _read_json(relative: str) -> dict[str, object]:
    """Return one vendored JSON file decoded as an object."""
    decoded = json.loads(_read_bytes(relative))
    assert isinstance(decoded, dict), relative
    return decoded


def _sha256(data: bytes) -> str:
    """Return the lowercase hex sha256 of ``data``."""
    return hashlib.sha256(data).hexdigest()


def _entries(relative: str) -> tuple[Mapping[str, object], ...]:
    """Return a manifest's ``files`` list as mappings."""
    files = _read_json(relative)["files"]
    assert isinstance(files, list), relative
    return tuple(entry for entry in files if isinstance(entry, dict))


def _digests(relative: str) -> dict[str, str]:
    """Return a manifest's ``path -> sha256`` mapping."""
    return {str(entry["path"]): str(entry["sha256"]) for entry in _entries(relative)}


def _example_cells(entries: tuple[Mapping[str, object], ...]) -> tuple[_Cell, ...]:
    """Build the example matrix from manifest entries rather than a written list."""
    return tuple(
        _Cell(
            capability=str(entry["capability"]),
            state=str(entry["state"]),
            path=str(entry["path"]),
            model=str(entry["model"]),
        )
        for entry in entries
        if entry["capability"] is not None
    )


def _is_unreachable(cell: _Cell) -> bool:
    """Return whether a cell holds Creek's "this branch does not exist" sentinel.

    Read from the payload's own ``unreachable`` marker, so the three sentinel
    cells drop out of every client-driving parametrisation as data rather than as
    a skip.
    """
    return _read_json(cell.path).get("unreachable") is True


def _cell_id(cell: _Cell) -> str:
    """Name a parametrised case after the matrix cell it drives."""
    return f"{cell.capability}-{cell.state}"


_CELLS = _example_cells(_entries(MANIFEST_NAME))
_REACHABLE = tuple(cell for cell in _CELLS if not _is_unreachable(cell))
_UNREACHABLE = tuple(cell for cell in _CELLS if _is_unreachable(cell))
_CAPABILITIES = frozenset(cell.capability for cell in _CELLS)
_STATES = frozenset(cell.state for cell in _CELLS)
_CAPABILITY_ERROR_CELLS = tuple(
    cell for cell in _REACHABLE if cell.capability == "capabilities" and cell.state in _ERROR_STATES
)


@dataclass
class _Recorder:
    """A route-aware ``MockTransport`` handler that records every request it sees.

    The capability path answers the derived handshake document, the wheel path
    its own vendored body, and every other path the journal exchange. Recording
    is load-bearing for the read-capability tests, which assert that no request
    left the process at all.
    """

    journal_payload: object = None
    journal_status: int = HTTPStatus.OK
    wheel_payload: object = None
    wheel_status: int = HTTPStatus.OK
    reflect_payload: object = None
    reflect_status: int = HTTPStatus.OK
    calls: list[str] = field(default_factory=list)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Answer one request, recording the method and path it arrived on."""
        self.calls.append(f"{request.method} {request.url.path}")
        if request.url.path == _CAPABILITIES_PATH:
            return httpx.Response(
                HTTPStatus.OK, json=_read_json("examples/capabilities/success.json")
            )
        if request.url.path == _WHEEL_PATH:
            return httpx.Response(self.wheel_status, json=self.wheel_payload)
        if request.url.path == _REFLECTIONS_PATH:
            return httpx.Response(self.reflect_status, json=self.reflect_payload)
        return httpx.Response(self.journal_status, json=self.journal_payload)


def _static_handler(payload: object, status: int) -> Handler:
    """Return a handler answering every request with one vendored document."""

    def _handle(_request: httpx.Request) -> httpx.Response:
        """Answer with the fixed payload and status."""
        return httpx.Response(status, json=payload)

    return _handle


def _ingest_request() -> VaultIngestRequest:
    """Build the one ingest request every journal cell is driven with."""
    return VaultIngestRequest(
        entry_id=_ENTRY_ID,
        body=_ENTRY_BODY,
        tier=VaultTierCeiling.PERSONAL,
        tier_ceiling=VaultTierCeiling.PERSONAL,
        created_at=_CREATED_AT,
    )


@pytest_asyncio.fixture
async def vault_clients() -> AsyncGenerator[ClientFactory, None]:
    """Yield a factory for MockTransport-backed vault clients, closing each after."""
    created: list[httpx.AsyncClient] = []

    def _build(handler: Handler) -> HttpCreekVaultClient:
        """Build one in-memory client and register its transport for teardown."""
        http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        created.append(http)
        return HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http)

    yield _build
    for http in created:
        await http.aclose()


def _published_frequency_codes() -> tuple[str, ...]:
    """Return the Frequency keys the wheel schema declares required, in published order."""
    defs = _read_json("schemas/WheelResponse.schema.json")["$defs"]
    assert isinstance(defs, dict)
    required = defs["WheelFrequencies"]["required"]
    assert isinstance(required, list)
    return tuple(str(code) for code in required)


async def _handshaken(clients: ClientFactory, recorder: _Recorder) -> HttpCreekVaultClient:
    """Return a client that has completed a handshake against the derived document."""
    client = clients(recorder)
    result = await client.handshake()
    assert result.available, "the derived capability document must complete a handshake"
    return client


async def _assert_ingest_result(
    clients: ClientFactory,
    payload: object,
    expected: VaultIngestResult,
) -> None:
    """Drive one journal upsert against ``payload`` and assert the exact result.

    Shared by the parametrised conformance cells and by the drift-sensitivity
    test, which feeds it a mutated payload and requires it to raise. That reuse is
    the point: it proves these assertions read the fields they claim to, rather
    than accepting whatever the vault happened to answer.
    """
    recorder = _Recorder(journal_payload=payload, journal_status=HTTPStatus.OK)
    client = await _handshaken(clients, recorder)

    assert await client.ingest(_ingest_request()) == expected


def _walk_strings(value: object) -> Iterable[str]:
    """Yield every string appearing as a key or a value anywhere in ``value``."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for key, item in value.items():
            yield key
            yield from _walk_strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from _walk_strings(item)


def _tier_values(value: object) -> Iterable[str]:
    """Yield every value carried by a tier-bearing field anywhere in ``value``."""
    if isinstance(value, dict):
        for key, item in value.items():
            if key in _TIER_FIELDS and isinstance(item, str):
                yield item
            yield from _tier_values(item)
    elif isinstance(value, list):
        for item in value:
            yield from _tier_values(item)


def _vendored_paths() -> frozenset[str]:
    """Return every vendored path on disk except our own sidecar."""
    return frozenset(
        str(path.relative_to(BUNDLE_ROOT))
        for path in BUNDLE_ROOT.rglob("*")
        if path.is_file() and path.name != VENDOR_NAME
    )


def _mutated_copy(tmp_path: Path, relative: str, old: str, new: str) -> Path:
    """Copy the bundle into ``tmp_path`` and rename one field inside one file."""
    root = tmp_path / "creek_v1"
    shutil.copytree(BUNDLE_ROOT, root)
    target = root / relative
    text = target.read_text(encoding="utf-8")
    assert old in text, f"{relative} must contain {old} for this mutation to mean anything"
    target.write_text(text.replace(old, new), encoding="utf-8")
    return root


# --------------------------------------------------------------------------
# (a) Bundle integrity and provenance
# --------------------------------------------------------------------------


def test_vendor_sidecar_records_the_pinned_provenance() -> None:
    """The sidecar names the repo, commit, path, and both versions it was cut from."""
    sidecar = _read_json(VENDOR_NAME)
    source = sidecar["source"]
    assert isinstance(source, dict)

    assert sidecar["bundle"] == "adepthood-v1"
    assert sidecar["contract_version"] == CONTRACT_VERSION
    assert sidecar["ontology_version"] == ONTOLOGY_VERSION
    assert source["repo"] == PINNED_REPO
    assert source["commit"] == PINNED_COMMIT
    assert source["path"] == PINNED_PATH


def test_every_vendored_file_matches_its_recorded_digest() -> None:
    """A vendored copy is a pin only while its bytes still hash to what we recorded."""
    recorded = _digests(VENDOR_NAME)

    assert len(recorded) == VENDORED_FILES
    for path, digest in sorted(recorded.items()):
        assert _sha256(_read_bytes(path)) == digest, path


def test_the_on_disk_file_set_is_exactly_the_recorded_file_set() -> None:
    """An unrecorded file on disk is as much drift as a changed one."""
    assert _vendored_paths() == frozenset(_digests(VENDOR_NAME))


def test_the_two_manifests_agree_on_every_shared_digest() -> None:
    """Our sidecar and Creek's manifest must never disagree about the same bytes."""
    sidecar = _digests(VENDOR_NAME)
    creek = _digests(MANIFEST_NAME)

    assert len(creek) == CREEK_MANIFEST_ENTRIES
    assert creek.keys() <= sidecar.keys()
    for path, digest in sorted(creek.items()):
        assert sidecar[path] == digest, path


def test_the_two_manifests_jointly_cover_every_vendored_path_once() -> None:
    """Creek's 45 plus the two files it cannot cover are exactly the 47 on disk."""
    creek = frozenset(_digests(MANIFEST_NAME))
    uncovered = frozenset({MANIFEST_NAME, README_NAME})

    assert not creek & uncovered
    assert creek | uncovered == _vendored_paths()
    assert len(creek) + len(uncovered) == VENDORED_FILES


# --------------------------------------------------------------------------
# (b) Version agreement
# --------------------------------------------------------------------------


def test_contract_version_agrees_across_both_manifests_and_the_domain_pin() -> None:
    """One version string in three places; any two of them disagreeing is the bug."""
    assert _read_json(VENDOR_NAME)["contract_version"] == CONTRACT_VERSION
    assert _read_json(MANIFEST_NAME)["contract_version"] == CONTRACT_VERSION
    assert CONTRACT_VERSION == "0.2.0"


def test_ontology_version_agrees_across_both_manifests() -> None:
    """The ontology the wire vocabulary is drawn from is pinned the same way."""
    assert _read_json(VENDOR_NAME)["ontology_version"] == ONTOLOGY_VERSION
    assert _read_json(MANIFEST_NAME)["ontology_version"] == ONTOLOGY_VERSION


# --------------------------------------------------------------------------
# (c) Conformance, parametrised from the vendored manifest
# --------------------------------------------------------------------------


def test_the_example_matrix_is_the_published_four_by_seven_grid() -> None:
    """Non-vacuity first: an emptied bundle fails here rather than passing silently."""
    assert len(_CELLS) == EXAMPLE_CELLS
    assert len(_CAPABILITIES) == CAPABILITY_COUNT
    assert len(_STATES) == STATE_COUNT
    assert len(_CELLS) == CAPABILITY_COUNT * STATE_COUNT
    assert len(_REACHABLE) == REACHABLE_CELLS
    assert len(_UNREACHABLE) == UNREACHABLE_CELLS


def test_the_parametrised_case_list_covers_every_capability() -> None:
    """The cases that drive the client must span all four capabilities, not one."""
    assert _REACHABLE != ()
    assert frozenset(cell.capability for cell in _REACHABLE) == _CAPABILITIES
    assert frozenset(cell.state for cell in _REACHABLE) == _STATES
    assert len(_CAPABILITY_ERROR_CELLS) == len(_ERROR_STATES)


def test_only_reflections_publishes_a_reachable_care_escalation() -> None:
    """The care guard runs in one capability, so the other three cells are sentinels."""
    assert {cell.capability for cell in _UNREACHABLE} == {
        "capabilities",
        "journal-upsert",
        "wheel",
    }
    assert {cell.state for cell in _UNREACHABLE} == {"care-escalation"}
    assert {cell.model for cell in _UNREACHABLE} == {"NotApplicableExample"}


def test_state_status_table_matches_the_manifest() -> None:
    """The one hand-maintained table must cover exactly the published state axis."""
    assert frozenset(_STATUS_BY_STATE) == _STATES


def test_capability_translation_table_matches_the_manifest() -> None:
    """The client's wire-name table must name exactly Creek's four published capabilities."""
    assert frozenset(_CAPABILITY_BY_CREEK_NAME) == _CAPABILITIES
    assert len(frozenset(_CAPABILITY_BY_CREEK_NAME.values())) == CAPABILITY_COUNT


def test_every_published_error_code_has_a_status_and_a_retry_disposition() -> None:
    """A newly published code must not default silently into an existing branch."""
    status_by_code: dict[str, int] = {}
    for cell in _REACHABLE:
        code = _read_json(cell.path).get("code")
        if isinstance(code, str):
            status_by_code.setdefault(code, _STATUS_BY_STATE[cell.state])
            assert status_by_code[code] == _STATUS_BY_STATE[cell.state], code

    assert status_by_code == {
        "privacy_refused": HTTPStatus.FORBIDDEN,
        "invalid_request": HTTPStatus.UNPROCESSABLE_ENTITY,
        "incompatible_version": HTTPStatus.CONFLICT,
        "unavailable": HTTPStatus.SERVICE_UNAVAILABLE,
    }
    assert frozenset(status_by_code) <= frozenset(_read_json(RETRY_POLICY_NAME))


@pytest.mark.asyncio
async def test_ratified_capability_documents_are_understood(
    vault_clients: ClientFactory,
) -> None:
    """Creek's own capability documents must handshake to their ratified outcome.

    Both 200 documents are asserted in one test because the two divergences are
    one behaviour: a client that reads Creek's document natively gets both cells
    right, and today's client gets the success cell wrong. The empty document
    happens to reach the ratified answer today, but only because the client never
    looks at the field that says so.
    """
    success = vault_clients(
        _static_handler(_read_json("examples/capabilities/success.json"), HTTPStatus.OK),
    )
    result = await success.handshake()

    assert result.available is True
    assert result.capabilities == frozenset(_CAPABILITY_BY_CREEK_NAME.values())
    assert success.supports(CreekCapability.JOURNAL) is True
    assert success.last_degrade_reason is None

    empty = vault_clients(
        _static_handler(_read_json("examples/capabilities/empty.json"), HTTPStatus.OK),
    )
    empty_result = await empty.handshake()

    assert empty_result.available is False
    assert empty.last_degrade_reason == HandshakeDegradeReason.VAULT_REPORTED_UNAVAILABLE


@pytest.mark.asyncio
async def test_observed_capability_empty_degrades_to_vault_reported_unavailable(
    vault_clients: ClientFactory,
) -> None:
    """The empty document's observed outcome coincides with its ratified one.

    Creek's uninitialized vault reports ``vault.available`` false and advertises
    nothing, and the client reports exactly that -- but for the wrong reason,
    reaching the same conclusion from the absence of a top-level key it would not
    have read either way.
    """
    client = vault_clients(
        _static_handler(_read_json("examples/capabilities/empty.json"), HTTPStatus.OK),
    )

    result = await client.handshake()

    assert result.available is False
    assert result.capabilities == frozenset()
    assert client.last_degrade_reason == HandshakeDegradeReason.VAULT_REPORTED_UNAVAILABLE


@pytest.mark.asyncio
@pytest.mark.parametrize("cell", _CAPABILITY_ERROR_CELLS, ids=_cell_id)
async def test_capability_error_states_degrade_as_unreachable(
    cell: _Cell,
    vault_clients: ClientFactory,
) -> None:
    """Every non-200 capability document degrades the handshake rather than raising.

    All four land on ``UNREACHABLE`` because the client raises for status before
    reading the body, so Creek's typed error envelope is never consulted. That is
    the observed behaviour; the envelope is what a fixed client would read.
    """
    client = vault_clients(_static_handler(_read_json(cell.path), _STATUS_BY_STATE[cell.state]))

    result = await client.handshake()

    assert result.available is False
    assert client.last_degrade_reason == HandshakeDegradeReason.UNREACHABLE


@pytest.mark.asyncio
async def test_journal_upsert_success_is_a_created_write(vault_clients: ClientFactory) -> None:
    """Creek's ratified success body is read as a durable, newly created fragment."""
    await _assert_ingest_result(
        vault_clients,
        _read_json("examples/journal-upsert/success.json"),
        VaultIngestResult(stored=True, vault_ref=_FRAGMENT_ID, action=VaultIngestAction.CREATED),
    )


@pytest.mark.asyncio
async def test_journal_upsert_empty_is_an_unchanged_write(vault_clients: ClientFactory) -> None:
    """Creek's empty state is a stored no-op re-send, not an error and not a loss."""
    await _assert_ingest_result(
        vault_clients,
        _read_json("examples/journal-upsert/empty.json"),
        VaultIngestResult(stored=True, vault_ref=_FRAGMENT_ID, action=VaultIngestAction.UNCHANGED),
    )


@pytest.mark.asyncio
async def test_journal_upsert_refusal_is_misreported_as_a_rejected_credential(
    vault_clients: ClientFactory,
) -> None:
    """Creek ratifies this cell as a privacy refusal; the write path reports a bad key.

    ``examples/journal-upsert/refusal.json`` carries ``privacy_refused`` at 403.
    The ingest path decides a credential-rejected status *before* it reads any
    code, so the refusal is classified on status alone and surfaces as an auth
    failure. An operator reading that would go and rotate a credential that was
    never refused. The read path resolved this by consulting the code first; the
    write path has not, and this cell records that it has not.
    """
    recorder = _Recorder(
        journal_payload=_read_json("examples/journal-upsert/refusal.json"),
        journal_status=HTTPStatus.FORBIDDEN,
    )
    client = await _handshaken(vault_clients, recorder)

    with pytest.raises(CreekVaultAuthError):
        await client.ingest(_ingest_request())


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("state", "expected"),
    [
        ("malformed-input", CreekVaultContractError),
        ("incompatible-version", CreekVaultContractError),
        ("unavailable-service", CreekVaultUnavailableError),
    ],
)
async def test_journal_upsert_error_states_raise_their_classified_failure(
    state: str,
    expected: type[Exception],
    vault_clients: ClientFactory,
) -> None:
    """Each ratified error body is classified into a failure an operator can act on.

    ``unavailable`` is the vault reporting on itself rather than faulting our
    request, so the 503 cell lands on the availability story whether the code is
    read or the status class decides.
    """
    recorder = _Recorder(
        journal_payload=_read_json(f"examples/journal-upsert/{state}.json"),
        journal_status=_STATUS_BY_STATE[state],
    )
    client = await _handshaken(vault_clients, recorder)

    with pytest.raises(expected):
        await client.ingest(_ingest_request())


@pytest.mark.asyncio
async def test_reflections_refuse_without_egress_when_unadvertised(
    vault_clients: ClientFactory,
) -> None:
    """A reflection the handshake never advertised is refused locally, whatever the wire says.

    This is the permanent half of the refusal reflections used to answer with
    unconditionally: the shape is ratified now, but a vault that did not offer the
    capability still gets no request. The no-egress assertion is the load-bearing
    one -- refusing after sending would already have put a whole journal entry on a
    wire toward a surface nobody claimed to serve.
    """
    recorder = _Recorder(reflect_payload=_read_json("examples/reflections/success.json"))
    client = vault_clients(recorder)

    with pytest.raises(CreekCapabilityUnsupportedError):
        await client.reflect(_ENTRY_BODY, _REFLECT_CEILING)

    assert recorder.calls == []


@pytest.mark.asyncio
async def test_reflections_success_cell_projects_to_a_domain_reflection(
    vault_clients: ClientFactory,
) -> None:
    """Creek's ratified reflection body reads back as its own note, in adepthood's vocabulary.

    Quote and note survive verbatim -- a quote is anchored character-for-character
    against the entry, so a trim would silently break it -- while the kind is
    projected, because ``pattern`` is Creek's word for a recurrence and
    ``connection`` is adepthood's.
    """
    published = _read_json("examples/reflections/success.json")
    notes = published["notes"]
    assert isinstance(notes, list)
    note = notes[0]
    assert isinstance(note, dict)
    recorder = _Recorder(reflect_payload=published)
    client = await _handshaken(vault_clients, recorder)

    reflection = await client.reflect(_ENTRY_BODY, _REFLECT_CEILING)

    assert note["kind"] == "pattern"
    assert reflection.status is VaultReflectionStatus.OK
    assert reflection.notes == (
        VaultReflectionNote(
            kind=_PATTERN_MARGINALIA_KIND, quote=str(note["quote"]), note=str(note["note"])
        ),
    )
    assert reflection.essay_grounded is False


@pytest.mark.asyncio
async def test_reflections_empty_cell_is_a_status_rather_than_a_failure(
    vault_clients: ClientFactory,
) -> None:
    """Creek's empty reflection is a successful answer with nothing to say, not an error."""
    published = _read_json("examples/reflections/empty.json")
    assert published["notes"] == []
    recorder = _Recorder(reflect_payload=published)
    client = await _handshaken(vault_clients, recorder)

    reflection = await client.reflect(_ENTRY_BODY, _REFLECT_CEILING)

    assert reflection.status is VaultReflectionStatus.EMPTY
    assert reflection.notes == ()


@pytest.mark.asyncio
async def test_reflections_care_escalation_cell_raises_out_of_the_seam(
    vault_clients: ClientFactory,
) -> None:
    """Creek's 200 care handoff leaves the seam as an escalation carrying none of its copy.

    It is deliberately not in the error hierarchy the read path degrades on:
    caught there, it would be answered with the cloud prose Creek's care guard
    declined to produce. And it carries nothing, because the message and resources
    below are Creek's own writing.
    """
    published = _read_json("examples/reflections/care-escalation.json")
    signal = published["care_signal"]
    assert isinstance(signal, dict)
    recorder = _Recorder(
        reflect_payload=published, reflect_status=_STATUS_BY_STATE["care-escalation"]
    )
    client = await _handshaken(vault_clients, recorder)

    with pytest.raises(CreekVaultCareEscalationError) as exc_info:
        await client.reflect(_ENTRY_BODY, _REFLECT_CEILING)

    assert not isinstance(exc_info.value, CreekVaultError)
    assert str(signal["message"]) not in repr(exc_info.value)
    assert str(published["reason"]) not in repr(exc_info.value)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("state", "expected"),
    [
        ("refusal", CreekVaultContractError),
        ("malformed-input", CreekVaultContractError),
        ("incompatible-version", CreekVaultContractError),
        ("unavailable-service", CreekVaultUnavailableError),
    ],
)
async def test_reflections_error_states_raise_their_classified_failure(
    state: str,
    expected: type[Exception],
    vault_clients: ClientFactory,
) -> None:
    """Each ratified reflection error is classified from the code Creek published on it.

    The refusal cell is the one that separates this path from the write path's:
    ``privacy_refused`` arrives at 403, and reading the status first would report
    it as a rejected credential.
    """
    recorder = _Recorder(
        reflect_payload=_read_json(f"examples/reflections/{state}.json"),
        reflect_status=_STATUS_BY_STATE[state],
    )
    client = await _handshaken(vault_clients, recorder)

    with pytest.raises(expected):
        await client.reflect(_ENTRY_BODY, _REFLECT_CEILING)


@pytest.mark.asyncio
async def test_wheel_refuses_without_egress_when_unadvertised(
    vault_clients: ClientFactory,
) -> None:
    """A wheel the handshake never advertised is refused locally, whatever the wire says.

    This is the permanent half of the refusal the wheel used to answer with
    unconditionally: the shape is ratified now, but a vault that did not offer
    the capability still gets no request, and the caller still degrades onto its
    local balance.
    """
    recorder = _Recorder(wheel_payload=_read_json("examples/wheel/success.json"))
    client = vault_clients(recorder)

    with pytest.raises(CreekCapabilityUnsupportedError):
        await client.wheel()

    assert recorder.calls == []


@pytest.mark.asyncio
async def test_wheel_success_cell_projects_to_a_domain_balance(
    vault_clients: ClientFactory,
) -> None:
    """Creek's ratified wheel body reads back as its ten Frequencies, in canonical order.

    The Frequency keys come from the published schema's own ``required`` list, so
    the ``F{n}`` to stage-``n`` projection is asserted against the contract rather
    than against a list restated here.
    """
    published = _read_json("examples/wheel/success.json")
    frequencies = published["wheel"]
    assert isinstance(frequencies, dict)
    recorder = _Recorder(wheel_payload=published)
    client = await _handshaken(vault_clients, recorder)

    balance = await client.wheel()

    assert [f"F{aspect.stage_number}" for aspect in balance.aspects] == list(
        _published_frequency_codes()
    )
    for aspect in balance.aspects:
        entry = frequencies[f"F{aspect.stage_number}"]
        assert aspect.aspect == entry["name"]
        assert aspect.fullness == entry["share"]


def test_reflections_refusal_is_a_privacy_refusal_envelope() -> None:
    """A refusal is an error envelope carrying a code and no care signal."""
    refusal = _read_json("examples/reflections/refusal.json")

    assert refusal["code"] == "privacy_refused"
    assert "care_signal" not in refusal
    assert "status" not in refusal
    assert refusal["request_id"] == "req-example-reflections-refusal"


def test_reflections_care_escalation_is_a_distinct_escalation_shape() -> None:
    """An escalation is a 200 care handoff with resources and no error code at all.

    Refusal and escalation are different published shapes at different statuses,
    which is what stops a client from collapsing "we will not answer this" and
    "you deserve human support right now" into one degraded path.
    """
    escalation = _read_json("examples/reflections/care-escalation.json")
    signal = escalation["care_signal"]
    assert isinstance(signal, dict)
    resources = signal["resources"]
    assert isinstance(resources, list)

    assert escalation["status"] == "escalate"
    assert signal["kind"] == "acute_distress"
    assert resources != []
    assert "code" not in escalation
    assert _STATUS_BY_STATE["care-escalation"] != _STATUS_BY_STATE["refusal"]


# --------------------------------------------------------------------------
# (d) Test-of-the-tests: provable drift sensitivity
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_renamed_response_field_is_caught_by_checksum_and_by_assertion(
    tmp_path: Path,
    vault_clients: ClientFactory,
) -> None:
    """Renaming one response field must fail both halves of this gate, not one.

    The checksum half proves the vendored bytes are watched; the assertion half
    proves the conformance assertions read the fields they claim to. A suite that
    only checksummed would notice the rename without knowing it mattered, and one
    that only asserted would never notice upstream moving underneath it.
    """
    relative = "examples/journal-upsert/success.json"
    root = _mutated_copy(tmp_path, relative, '"fragment_id"', '"fragmentId"')

    report = verify_local(root)

    assert [change.path for change in report.changes] == [relative]
    assert report.changes[0].capability == "journal-upsert"
    assert report.exit_code == EXIT_DRIFT

    mutated = json.loads((root / relative).read_text(encoding="utf-8"))
    with pytest.raises(AssertionError, match="stored"):
        await _assert_ingest_result(
            vault_clients,
            mutated,
            VaultIngestResult(
                stored=True,
                vault_ref=_FRAGMENT_ID,
                action=VaultIngestAction.CREATED,
            ),
        )


def test_a_renamed_request_parameter_is_caught_by_the_checksum(tmp_path: Path) -> None:
    """A request-shape change has no response to assert on, so the digest must catch it."""
    relative = "schemas/JournalUpsertRequest.schema.json"
    root = _mutated_copy(tmp_path, relative, '"content"', '"entry_content"')

    report = verify_local(root)

    assert [change.path for change in report.changes] == [relative]
    assert report.changes[0].capability is None
    assert report.exit_code == EXIT_DRIFT


# --------------------------------------------------------------------------
# (e) Privacy invariants
# --------------------------------------------------------------------------


@pytest.mark.parametrize("cell", _CELLS, ids=_cell_id)
def test_no_example_names_the_intimate_tier_in_any_tier_field(cell: _Cell) -> None:
    """Intimate content never egresses, so no published example may route at it."""
    assert _FORBIDDEN_TIER not in set(_tier_values(_read_json(cell.path)))


def test_the_capability_document_publishes_the_two_ceiling_tier_model() -> None:
    """The tier model is advertised up front, and it admits exactly two ceilings."""
    tier_model = _read_json("examples/capabilities/success.json")["tier_model"]
    assert isinstance(tier_model, dict)

    assert tier_model["ceilings"] == ["open", "personal"]
    assert tier_model["intimate_never_egresses"] is True
    assert tier_model["default"] == "open"


@pytest.mark.parametrize("relative", sorted(_vendored_paths()))
def test_no_vendored_file_carries_a_credential_shaped_value(relative: str) -> None:
    """A published contract bundle must contain no key, token, or bearer header."""
    text = _read_bytes(relative).decode("utf-8")

    for marker in _CREDENTIAL_MARKERS:
        assert marker not in text, f"{relative} carries {marker}"


@pytest.mark.parametrize("cell", _CELLS, ids=_cell_id)
def test_example_prose_is_bounded_synthetic_text_not_a_journal_body(cell: _Cell) -> None:
    """No example may carry real writing, expressed as two checkable bounds.

    A journal body would travel under a ``content`` or ``body`` key, and would be
    longer than any string Creek actually publishes -- the longest is its
    201-character care message.
    """
    payload = _read_json(cell.path)
    longest = max(len(item) for item in _walk_strings(payload))

    assert not any(key in payload for key in _BODY_KEYS)
    assert longest <= _MAX_EXAMPLE_STRING


def test_the_reflection_example_is_labelled_synthetic_prose() -> None:
    """The one example carrying note text says in the text itself that it is synthetic."""
    notes = _read_json("examples/reflections/success.json")["notes"]
    assert isinstance(notes, list)
    note = notes[0]
    assert isinstance(note, dict)

    assert str(note["note"]).startswith("Synthetic example prose.")
    assert note["quote"] == "I keep saying yes to things I do not want"
    assert note["kind"] == "pattern"


def test_the_bundle_root_is_this_directorys_vendored_fixture_tree() -> None:
    """The drift script and this suite must read the same vendored bundle."""
    assert BUNDLE_ROOT.resolve() == (Path(__file__).parent / "fixtures" / "creek_v1").resolve()
