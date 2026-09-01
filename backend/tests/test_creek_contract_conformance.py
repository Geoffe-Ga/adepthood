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
   a sha256 for every file it covers -- it covers neither itself nor the
   hand-written ``README.md``, which is why the two counts here differ by two.
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

The capability list is no longer minor-independent
--------------------------------------------------

Through contract 0.7 every supported minor was answered the same four capability
names, so "what a vault advertises" was a fact about the vault alone. Contract
0.8.0 ends that: ``GET /v1/capabilities`` keys what it advertises on the
caller's declared minor, ``upload`` is published only at or above ``0.8``, and
``POST /v1/uploads`` refuses a caller below that threshold outright. The
consequence for this suite is that ``examples/capabilities/success.json`` is the
document a **0.10** caller receives, not a document every caller receives, and
the counts in :mod:`tests.creek_bundle_facts` (seven capabilities, forty-nine
cells, six unreachable care-escalation sentinels) are the 0.10 shape rather than
a permanent one. 0.9.0 added ``drive-connector`` and 0.10.0 added ``pipeline``,
so the axis has grown twice in three weeks; treat every count here as a fact
about one pinned commit.

Naming a capability is not calling it
-------------------------------------

Adepthood has no route, client method or caller for ``drive-connector`` or
``pipeline``. They are in :data:`_CAPABILITY_BY_WIRE_NAME` because the client
drops advertised names it cannot map, so omitting them would make a vault that
offers them indistinguishable from one that does not. The tests below therefore
assert that both names *translate* and that neither becomes callable.
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
from typing import cast

import httpx
import pytest
import pytest_asyncio

from domain.creek_vault import (
    CONTRACT_VERSION,
    CreekCapability,
    CreekCapabilityUnsupportedError,
    CreekCeilingUnrepresentableError,
    CreekVaultCareEscalationError,
    CreekVaultContractError,
    CreekVaultError,
    CreekVaultUnavailableError,
    VaultErrorCode,
    VaultIngestAction,
    VaultIngestRequest,
    VaultIngestResult,
    VaultPraxisKind,
    VaultPraxisStatus,
    VaultReflectionNote,
    VaultReflectionStatus,
    VaultRelatedEddy,
    VaultRelatedPraxis,
    VaultTierCeiling,
    VaultUploadRequest,
    VaultUploadResult,
    wire_ceiling_for,
)
from scripts.creek_contract_drift import BUNDLE_ROOT, EXIT_DRIFT, verify_local
from services.creek_vault_client import (
    _CAPABILITY_BY_WIRE_NAME,
    HandshakeDegradeReason,
    HttpCreekVaultClient,
)
from tests.creek_bundle_facts import (
    BUNDLE_NAME,
    CAPABILITY_COUNT,
    CREEK_MANIFEST_ENTRIES,
    CREEK_NOTE_KINDS,
    EXAMPLE_CELLS,
    ONTOLOGY_VERSION,
    PINNED_COMMIT,
    PINNED_CONTRACT_VERSION,
    PINNED_PATH,
    PINNED_REPO,
    REACHABLE_CELLS,
    SCHEMA_FILES,
    STATE_COUNT,
    UNREACHABLE_CELLS,
    VENDORED_FILES,
)

MANIFEST_NAME = "manifest.json"
README_NAME = "README.md"
VENDOR_NAME = "vendor.json"
RETRY_POLICY_NAME = "retry-policy.json"

_VAULT_URL = "https://vault.example.test"
_API_KEY = "creek-vault-conformance-key"  # pragma: allowlist secret
_CAPABILITIES_PATH = "/v1/capabilities"
_WHEEL_PATH = "/v1/wheel"
_REFLECTIONS_PATH = "/v1/reflections"
_UPLOADS_PATH = "/v1/uploads"

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

# The one document every upload cell is driven with. The bytes are synthetic and
# the id is adepthood's own generated shape rather than a filename, which is what
# the seam actually sends: a filename is the user's words about their life and
# does not belong in an id.
_UPLOAD_EXTERNAL_ID = "adepthood-upload-conformance"
_UPLOAD_FILENAME = "field-notes.pdf"
_UPLOAD_CONTENT_B64 = "ZXhhbXBsZSBkb2N1bWVudCBieXRlcw=="
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

# The two published request shapes that write into the vault, and the field both
# must demand. Creek removed this field's ``open`` default from its write tools
# at 0.7.0 -- a caller that omitted it had its content filed in the clear -- and
# typed the upload's copy to the wire ceiling at 0.8.0, so omission is not
# defaultable and ``intimate`` is not expressible. Adepthood satisfies both by
# construction; the tests below pin that rather than rebuild it.
_WRITE_REQUEST_SCHEMAS = (
    "schemas/JournalUpsertRequest.schema.json",
    "schemas/UploadRequest.schema.json",
)
_TIER_FIELD = "tier"
_WIRE_TIER_CEILING_DEF = "WireTierCeiling"
_WIRE_TIER_CEILING_REF = f"#/$defs/{_WIRE_TIER_CEILING_DEF}"
_PUBLISHED_WIRE_CEILINGS = ("open", "personal")

_REFLECTION_NOTE_SCHEMA = "schemas/ReflectionNote.schema.json"
_NOTE_KIND_DEF = "NoteKind"
_NOTE_KIND_REF = f"#/$defs/{_NOTE_KIND_DEF}"
_KIND_FIELD = "kind"

_CLASSIFICATION_REQUEST_SCHEMA = "schemas/ClassificationRequest.schema.json"

#: Every property Creek's whole-vault classification request publishes, measured
#: from the bundle and then written down. Pinned as the WHOLE set rather than as
#: the absence of one named key, because a fragment selector has no fixed
#: spelling -- ``fragment_ids``, ``entry_ids``, ``since``, a filter object --
#: and an absence guard naming a spelling Creek never chose would pass forever.
#: A set equality cannot be dodged by spelling: any eighth key reddens it.
_CLASSIFICATION_REQUEST_PROPERTIES = frozenset({"method", "retier"})

#: The promise the request schema's own description makes, quoted from the
#: vendored bytes. The property set catches a selector that has *arrived*; this
#: catches the promise being *softened* -- a re-vendor that says a selector may
#: come later leaves the properties untouched, and that erosion is the earliest
#: honest signal that adepthood's per-entry deferral needs revisiting.
_NO_FRAGMENT_SELECTOR_PROMISE = "There is no fragment selector, and there will not be one."

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

# The directory every published JSON Schema lives under.
_SCHEMA_DIR = "schemas/"

# The vendored README is hand-written upstream and excluded from Creek's own
# round-trip test, so its prose was never regenerated as the matrix grew: it
# still describes the 0.7 bundle. It is vendored byte-for-byte and cannot be
# corrected here -- editing it would turn the digest gate red -- and the contract
# audit playbook names this directory its first source of truth, ahead of every
# ADR and issue body. So the divergence is pinned rather than left as a trap for
# the next reader. Each entry is a phrase quoted from the vendored bytes, the
# count that phrase states, and the count the bundle beside it actually holds.
_README_STALE_SCHEMA_FILES = 16
_README_STALE_EXAMPLE_CELLS = 35
_README_STALE_CAPABILITY_COUNT = 5
_README_STALE_UNREACHABLE_CELLS = 4
_README_STALE_PROSE: Mapping[str, tuple[int, int]] = {
    "one JSON Schema per CONTRACT_MODELS entry (16 files)": (
        _README_STALE_SCHEMA_FILES,
        SCHEMA_FILES,
    ),
    "one fixture per (capability, state) cell (5 \u00d7 7 = 35 files)": (
        _README_STALE_EXAMPLE_CELLS,
        EXAMPLE_CELLS,
    ),
    "**Capabilities** (five)": (
        _README_STALE_CAPABILITY_COUNT,
        CAPABILITY_COUNT,
    ),
    "Why four cells are `NotApplicableExample`": (
        _README_STALE_UNREACHABLE_CELLS,
        UNREACHABLE_CELLS,
    ),
}


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


def _only_related(payload: dict[str, object], field_name: str) -> dict[str, object]:
    """Return the single compiled page one related collection of a reflection cell carries."""
    published = payload[field_name]
    assert isinstance(published, list), field_name
    assert len(published) == 1, field_name
    page = published[0]
    assert isinstance(page, dict), field_name
    return page


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

    Read from the payload's own ``unreachable`` marker, so the sentinel cells
    drop out of every client-driving parametrisation as data rather than as a
    skip. There is one per capability whose care guard does not run, which is
    every capability except ``reflections``.
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
    upload_payload: object = None
    upload_status: int = HTTPStatus.OK
    calls: list[str] = field(default_factory=list)
    bodies: list[object] = field(default_factory=list)

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
        if request.url.path == _UPLOADS_PATH:
            self.bodies.append(json.loads(request.content))
            return httpx.Response(self.upload_status, json=self.upload_payload)
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


def _upload_request(tier: VaultTierCeiling = VaultTierCeiling.PERSONAL) -> VaultUploadRequest:
    """Build the one upload request every document cell is driven with."""
    return VaultUploadRequest(
        external_id=_UPLOAD_EXTERNAL_ID,
        filename=_UPLOAD_FILENAME,
        content_base64=_UPLOAD_CONTENT_B64,
        tier=tier,
        tier_ceiling=tier,
        created_at=_CREATED_AT,
    )


def _upload_example(state: str) -> dict[str, object]:
    """Return one vendored upload example by its published state name."""
    return _read_json(f"examples/upload/{state}.json")


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

    assert sidecar["bundle"] == BUNDLE_NAME
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
    """Creek's entries plus the two files it cannot cover are exactly what is on disk."""
    creek = frozenset(_digests(MANIFEST_NAME))
    uncovered = frozenset({MANIFEST_NAME, README_NAME})

    assert not creek & uncovered
    assert creek | uncovered == _vendored_paths()
    assert len(creek) + len(uncovered) == VENDORED_FILES


def test_the_vendored_readme_prose_is_stale_in_exactly_the_known_places() -> None:
    """Upstream's hand-written prose still describes the 0.7 bundle it ships beside.

    The audit playbook sends a reader to this directory before any ADR or issue
    body, and the first file there is the README -- which states five
    capabilities, a 5 by 7 matrix, 16 schemas and four sentinel cells. Every one
    of those was true at 0.7 and none is true now. The bytes are upstream's and
    must stay byte-identical, so the divergence is pinned here instead of
    corrected: each phrase must still be present, and each count it states must
    still disagree with what the bundle holds. When upstream regenerates the
    prose this fails, and the warning it justifies in
    ``prompts/audits/contract-drift-audit.md`` can be retired alongside it.
    """
    readme = _read_bytes(README_NAME).decode()
    schemas = [path for path in _digests(MANIFEST_NAME) if path.startswith(_SCHEMA_DIR)]

    assert len(schemas) == SCHEMA_FILES
    for phrase, (stated, published) in _README_STALE_PROSE.items():
        assert phrase in readme, phrase
        assert stated != published, phrase


# --------------------------------------------------------------------------
# (b) Version agreement
# --------------------------------------------------------------------------


def test_contract_version_agrees_across_both_manifests_and_the_domain_pin() -> None:
    """One version string in three places; any two of them disagreeing is the bug."""
    assert _read_json(VENDOR_NAME)["contract_version"] == CONTRACT_VERSION
    assert _read_json(MANIFEST_NAME)["contract_version"] == CONTRACT_VERSION
    assert CONTRACT_VERSION == PINNED_CONTRACT_VERSION


def test_ontology_version_agrees_across_both_manifests() -> None:
    """The ontology the wire vocabulary is drawn from is pinned the same way."""
    assert _read_json(VENDOR_NAME)["ontology_version"] == ONTOLOGY_VERSION
    assert _read_json(MANIFEST_NAME)["ontology_version"] == ONTOLOGY_VERSION


# --------------------------------------------------------------------------
# (c) Conformance, parametrised from the vendored manifest
# --------------------------------------------------------------------------


def test_the_example_matrix_is_the_published_seven_by_seven_grid() -> None:
    """Non-vacuity first: an emptied bundle fails here rather than passing silently."""
    assert len(_CELLS) == EXAMPLE_CELLS
    assert len(_CAPABILITIES) == CAPABILITY_COUNT
    assert len(_STATES) == STATE_COUNT
    assert len(_CELLS) == CAPABILITY_COUNT * STATE_COUNT
    assert len(_REACHABLE) == REACHABLE_CELLS
    assert len(_UNREACHABLE) == UNREACHABLE_CELLS


def test_the_parametrised_case_list_covers_every_capability() -> None:
    """The cases that drive the client must span every published capability, not one."""
    assert _REACHABLE != ()
    assert frozenset(cell.capability for cell in _REACHABLE) == _CAPABILITIES
    assert frozenset(cell.state for cell in _REACHABLE) == _STATES
    assert len(_CAPABILITY_ERROR_CELLS) == len(_ERROR_STATES)


def test_only_reflections_publishes_a_reachable_care_escalation() -> None:
    """The care guard runs in one capability, so every other cell is a sentinel."""
    assert {cell.capability for cell in _UNREACHABLE} == _CAPABILITIES - {"reflections"}
    assert {cell.state for cell in _UNREACHABLE} == {"care-escalation"}
    assert {cell.model for cell in _UNREACHABLE} == {"NotApplicableExample"}


def test_state_status_table_matches_the_manifest() -> None:
    """The one hand-maintained table must cover exactly the published state axis."""
    assert frozenset(_STATUS_BY_STATE) == _STATES


def test_capability_translation_table_matches_the_manifest() -> None:
    """The client's wire-name table must name exactly Creek's published capabilities.

    Not some of them, and not some plus whatever the client invented: the set is
    read off the manifest, so a capability Creek publishes and the client cannot
    name fails here rather than silently degrading every call that needs it. The
    injectivity half matters just as much -- two wire names collapsing onto one
    member would make ``supports`` answer for a capability nobody advertised.
    """
    assert frozenset(_CAPABILITY_BY_CREEK_NAME) == _CAPABILITIES
    assert len(frozenset(_CAPABILITY_BY_CREEK_NAME.values())) == CAPABILITY_COUNT


def test_the_capability_document_advertises_exactly_the_published_matrix_axis() -> None:
    """What a 0.10 caller is told and what the matrix documents are one list.

    The advertised list and the example directory names are generated from the
    same upstream enum, so a bundle where they disagree is a bundle that was
    assembled wrong -- and asserting it here is what stops the matrix-driven
    tests below from silently exercising a capability no vault ever offers.
    """
    advertised = _read_json("examples/capabilities/success.json")["capabilities"]
    assert isinstance(advertised, list)

    assert frozenset(advertised) == _CAPABILITIES
    assert len(advertised) == CAPABILITY_COUNT


@pytest.mark.asyncio
async def test_no_advertised_capability_is_dropped_at_the_parse_boundary(
    vault_clients: ClientFactory,
) -> None:
    """An advertised name the client cannot map is discarded without a sound.

    That silence is the whole hazard: a vault offering ``drive-connector`` and
    one that does not would hand back identical handshake results, and no log
    line, metric or error would distinguish them. Counting what survives the
    parse is the only way to notice, so this compares the *sizes* rather than
    re-deriving the expected set through the table under test.
    """
    published = _read_json("examples/capabilities/success.json")
    advertised = published["capabilities"]
    assert isinstance(advertised, list)
    client = vault_clients(_static_handler(published, HTTPStatus.OK))

    result = await client.handshake()

    assert len(result.capabilities) == len(advertised)
    assert client.supports(CreekCapability.DRIVE_CONNECTOR) is True
    assert client.supports(CreekCapability.PIPELINE) is True


@pytest.mark.asyncio
async def test_an_advertised_pipeline_leaves_adepthoods_classify_refusing(
    vault_clients: ClientFactory,
) -> None:
    """Creek's ``pipeline`` is not adepthood's ``CLASSIFY``, and must not become it.

    Both words describe classification, which is exactly why the two are pinned
    apart here. Creek's pipeline is a whole-vault classify-and-link pass that
    names no fragment; ``CreekCapability.CLASSIFY`` is adepthood's per-entry
    concept whose request shape is still unratified, so :meth:`classify` refuses.
    Had the wire name been mapped onto that member to keep the table injective,
    ``supports`` would answer true for a call that always raises -- a degrade
    turned into a lie. Asserted through the table rather than as an identity
    between two enum members, because the latter is a comparison a type checker
    can settle without running anything: it is the *mapping* that could have
    been written the wrong way, not the enum.
    """
    published = _read_json("examples/capabilities/success.json")
    client = vault_clients(_static_handler(published, HTTPStatus.OK))
    await client.handshake()

    assert _CAPABILITY_BY_CREEK_NAME["pipeline"] is not CreekCapability.CLASSIFY
    assert client.supports(CreekCapability.CLASSIFY) is False
    with pytest.raises(CreekCapabilityUnsupportedError):
        await client.classify(_ENTRY_BODY, _REFLECT_CEILING)


def test_the_capabilities_added_since_0_8_are_named_and_carry_a_full_example_column() -> None:
    """Creek's 0.9 and 0.10 additions are translatable and fully documented.

    Named, because an untranslatable capability is dropped in silence; fully
    documented, because a capability that arrived with a partial example column
    would leave the matrix-driven privacy and prose tests below covering less
    than they appear to.
    """
    added = frozenset({"drive-connector", "pipeline"})

    assert added <= frozenset(_CAPABILITY_BY_CREEK_NAME)
    assert added <= _CAPABILITIES
    for capability in sorted(added):
        column = frozenset(cell.state for cell in _CELLS if cell.capability == capability)
        assert column == _STATES, capability


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

    All four still land on ``UNREACHABLE``, but no longer because the envelope
    goes unread. The handshake now consults it, and asks it exactly one
    question: is this a credential-rejected status carrying *no* code, and so a
    key to rotate rather than a vault to go and look at? Every one of these four
    fixtures carries a code -- the 403 refusal included -- so none of them is
    that, and all four answer to the availability story.

    What the envelope still does not do here is fan its codes out into the
    reasons the handshake already has names for: ``unavailable`` into
    ``VAULT_REPORTED_UNAVAILABLE``, ``incompatible_version`` into
    ``INCOMPATIBLE_VERSION``. Both of those are reachable today only from a 200
    body. That remaining collapse is what these cells record.
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
async def test_journal_upsert_refusal_reports_a_refusal_not_a_rejected_credential(
    vault_clients: ClientFactory,
) -> None:
    """Creek ratifies this cell as a privacy refusal, and the write path now says so.

    ``examples/journal-upsert/refusal.json`` carries ``privacy_refused`` at 403.
    The ingest path used to decide a credential-rejected status *before* reading
    any code, so the refusal was classified on status alone and surfaced as an
    auth failure -- sending an operator to rotate a credential that was never
    refused, while the actual remedy went unmentioned. This cell recorded that
    misreport as known until the write path was aligned with the read paths,
    which had consulted the code first all along.

    Inverted rather than deleted so the reversal stays legible here.
    """
    recorder = _Recorder(
        journal_payload=_read_json("examples/journal-upsert/refusal.json"),
        journal_status=HTTPStatus.FORBIDDEN,
    )
    client = await _handshaken(vault_clients, recorder)

    with pytest.raises(CreekVaultContractError) as raised:
        await client.ingest(_ingest_request())

    assert raised.value.code is VaultErrorCode.PRIVACY_REFUSED


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
async def test_upload_success_cell_is_a_created_write(vault_clients: ClientFactory) -> None:
    """Creek's ratified upload body reads back as a durable, newly created fragment.

    The fragment id is read out of the published example rather than restated, so
    a fixture that moved underneath this suite fails here as well as at the
    checksum.
    """
    published = _upload_example("success")
    recorder = _Recorder(upload_payload=published)
    client = await _handshaken(vault_clients, recorder)

    result = await client.upload(_upload_request())

    assert result == VaultUploadResult(
        stored=True,
        vault_ref=str(published["fragment_id"]),
        action=VaultIngestAction.CREATED,
        tags=(),
    )


@pytest.mark.asyncio
async def test_upload_empty_cell_is_an_unchanged_resend(vault_clients: ClientFactory) -> None:
    """Creek's empty state is a stored no-op re-send, which is what idempotence looks like.

    Re-sending an unmodified document is the steady state of this path, not an
    error and not a loss, and a client must be able to tell it apart from a write
    without diffing the document itself.
    """
    published = _upload_example("empty")
    recorder = _Recorder(upload_payload=published)
    client = await _handshaken(vault_clients, recorder)

    result = await client.upload(_upload_request())

    assert result.stored is True
    assert result.action is VaultIngestAction.UNCHANGED
    assert result.vault_ref == str(published["fragment_id"])


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
async def test_upload_error_states_raise_their_classified_failure(
    state: str,
    expected: type[Exception],
    vault_clients: ClientFactory,
) -> None:
    """Each ratified upload error is classified from the code Creek published on it.

    The incompatible-version cell is the one 0.8.0 made routine rather than
    theoretical: the capability list is keyed on the caller's declared minor, so a
    vault can serve this route perfectly well and still refuse *this* caller. The
    refusal cell is the other load-bearing one -- ``privacy_refused`` arrives at
    403, and deciding on the status class first would report it as a rejected
    credential and send an operator to rotate a key that was never refused.
    """
    recorder = _Recorder(
        upload_payload=_upload_example(state), upload_status=_STATUS_BY_STATE[state]
    )
    client = await _handshaken(vault_clients, recorder)

    with pytest.raises(expected):
        await client.upload(_upload_request())


@pytest.mark.asyncio
async def test_upload_refuses_without_egress_when_unadvertised(
    vault_clients: ClientFactory,
) -> None:
    """An upload the handshake never advertised is refused locally, whatever the wire says.

    The permanent half of the refusal ``upload()`` used to answer with
    unconditionally. Its shape is ratified now, but a vault that did not offer the
    capability still gets no request -- and here that is a whole document rather
    than one entry, with no local copy anywhere if it went astray.
    """
    recorder = _Recorder(upload_payload=_upload_example("success"))
    client = vault_clients(recorder)

    with pytest.raises(CreekCapabilityUnsupportedError):
        await client.upload(_upload_request())

    assert recorder.calls == []


@pytest.mark.asyncio
async def test_an_upload_puts_the_published_request_on_the_wire(
    vault_clients: ClientFactory,
) -> None:
    """The body adepthood sends is exactly the field set ``UploadRequest`` declares.

    Read off the vendored schema rather than restated, and asserted as a whole
    set: the shape forbids unknown properties, so an invented field is a refused
    request, and a missing ``tier`` is a document filed at a depth nobody chose.
    """
    published = _read_json("schemas/UploadRequest.schema.json")["properties"]
    assert isinstance(published, dict)
    recorder = _Recorder(upload_payload=_upload_example("success"))
    client = await _handshaken(vault_clients, recorder)

    await client.upload(_upload_request())

    assert recorder.calls[-1] == f"POST {_UPLOADS_PATH}"
    sent = recorder.bodies[-1]
    assert isinstance(sent, dict)
    assert frozenset(sent) == frozenset(published)
    assert sent[_TIER_FIELD] == VaultTierCeiling.PERSONAL.value
    assert sent["external_id"] == _UPLOAD_EXTERNAL_ID


@pytest.mark.asyncio
async def test_an_intimate_upload_is_refused_before_any_request_exists(
    vault_clients: ClientFactory,
) -> None:
    """The tier with no wire spelling stops at adepthood's own door, carrying the document.

    The published request types ``tier`` to the two ceilings a remote caller may
    declare, and :func:`wire_ceiling_for` refuses rather than narrowing -- so the
    document never becomes a request at all, and the no-egress assertion is what
    proves it.
    """
    recorder = _Recorder(upload_payload=_upload_example("success"))
    client = await _handshaken(vault_clients, recorder)
    handshake_calls = list(recorder.calls)

    with pytest.raises(CreekCeilingUnrepresentableError):
        await client.upload(_upload_request(VaultTierCeiling.INTIMATE))

    assert recorder.calls == handshake_calls
    assert recorder.bodies == []


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
async def test_reflections_success_cell_projects_its_related_pages(
    vault_clients: ClientFactory,
) -> None:
    """The compiled pages Creek publishes beside the notes read back as their own values.

    Read off the ratified cell rather than a synthetic body, so the two
    collections are pinned to bytes upstream signed: a renamed field or a
    restated praxis vocabulary fails here rather than quietly surfacing nothing.
    """
    published = _read_json("examples/reflections/success.json")
    praxis = _only_related(published, "related_praxis")
    eddy = _only_related(published, "related_eddies")
    recorder = _Recorder(reflect_payload=published)
    client = await _handshaken(vault_clients, recorder)

    reflection = await client.reflect(_ENTRY_BODY, _REFLECT_CEILING)

    assert reflection.related_praxis == (
        VaultRelatedPraxis(
            title=str(praxis["title"]),
            praxis_type=VaultPraxisKind(str(praxis["praxis_type"])),
            status=VaultPraxisStatus(str(praxis["status"])),
            excerpt=str(praxis["excerpt"]),
        ),
    )
    assert reflection.related_eddies == (
        VaultRelatedEddy(
            title=str(eddy["title"]),
            description=str(eddy["description"]),
            fragment_count=cast("int", eddy["fragment_count"]),
            formed=str(eddy["formed"]),
        ),
    )


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

    The refusal cell is the load-bearing one: ``privacy_refused`` arrives at 403,
    and reading the status first would report it as a rejected credential. It
    used to be what separated this path from the write path's; the write path is
    aligned on code-first now, so the cell no longer marks a divergence -- it
    pins the rule both paths keep.
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


def test_the_bundle_publishes_exactly_the_pinned_note_kinds() -> None:
    """The vendored ``NoteKind`` enum is the vocabulary the pin names, entire.

    ``services.creek_vault_payload`` drops a margin note whose kind is missing
    from its table -- right, because a kind nobody has decided how to render must
    not be coerced onto a neighbour -- but it drops it in silence. Only one kind,
    ``pattern``, was compared against the bundle anywhere, so a re-vendor that
    grew the vocabulary reddened nothing that describes it: the digests go red
    once and are regenerated as a step of the re-vendor, and the schema-file
    count is unmoved because a new enum member adds no file.

    Two independent claims, neither derived from the other: the client suite
    asserts the mapping against the pin, and this asserts the pin against the
    bundle. Deriving the pin from the bundle instead would let a truncated
    schema quietly redefine what "correct" means.
    """
    schema = _read_json(_REFLECTION_NOTE_SCHEMA)

    properties = schema["properties"]
    assert isinstance(properties, dict)
    assert properties[_KIND_FIELD]["$ref"] == _NOTE_KIND_REF

    defs = schema["$defs"]
    assert isinstance(defs, dict)
    published = defs[_NOTE_KIND_DEF]["enum"]
    assert isinstance(published, list), _REFLECTION_NOTE_SCHEMA
    assert published, _REFLECTION_NOTE_SCHEMA
    assert len(published) == len(CREEK_NOTE_KINDS), published
    assert set(published) == CREEK_NOTE_KINDS


def test_the_classification_request_still_names_no_fragment() -> None:
    """Creek's classification pass stays whole-vault, so the deferral stands.

    Creek publishes a classification capability -- ``pipeline`` -- and adepthood
    still refuses :attr:`~domain.creek_vault.CreekCapability.CLASSIFY`. The two
    are not the same request: adepthood's is per-entry, and the published one
    names no fragment at all, which is why declining to wire them together is a
    reading of the contract rather than a gap in it.

    A fragment selector arriving upstream is precisely the event that would
    reopen that deferral, and today it would land in silence: the vendored
    classification schemas are read by nothing else in this repo, so digest
    drift would report that a file changed without anyone learning that the one
    property the deferral rests on had appeared.
    """
    schema = _read_json(_CLASSIFICATION_REQUEST_SCHEMA)

    properties = schema["properties"]
    assert isinstance(properties, dict)
    assert properties, _CLASSIFICATION_REQUEST_SCHEMA
    assert len(properties) == len(_CLASSIFICATION_REQUEST_PROPERTIES), sorted(properties)
    assert frozenset(properties) == _CLASSIFICATION_REQUEST_PROPERTIES

    # Without this the set above pins only what a *documented* caller may send:
    # an open schema would admit a selector nobody had to publish first.
    assert schema["additionalProperties"] is False

    description = schema["description"]
    assert isinstance(description, str)
    assert _NO_FRAGMENT_SELECTOR_PROMISE in description


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


@pytest.mark.parametrize("relative", _WRITE_REQUEST_SCHEMAS)
def test_every_write_request_schema_demands_an_explicit_two_ceiling_tier(relative: str) -> None:
    """Both published write shapes require ``tier`` and admit only the two wire ceilings.

    Two properties, and the pairing is the point. *Required* means omission is
    not defaultable, so a caller that says nothing about a document's depth is
    refused rather than having it filed in the clear. *Two-member* means
    ``intimate`` has no spelling at all, so the depth that must never egress
    cannot be named even deliberately. Read off the bundle rather than restated,
    because a schema that quietly regained a default would still satisfy a
    hand-written copy of this rule.
    """
    schema = _read_json(relative)
    required = schema["required"]
    assert isinstance(required, list)
    assert _TIER_FIELD in required

    properties = schema["properties"]
    assert isinstance(properties, dict)
    assert properties[_TIER_FIELD]["$ref"] == _WIRE_TIER_CEILING_REF

    defs = schema["$defs"]
    assert isinstance(defs, dict)
    assert defs[_WIRE_TIER_CEILING_DEF]["enum"] == list(_PUBLISHED_WIRE_CEILINGS)


def test_the_wire_ceiling_translation_admits_exactly_the_published_ceilings() -> None:
    """Adepthood's one door onto the wire vocabulary matches the published enum.

    The bundle says which ceilings a remote caller may name; this asserts the
    translation agrees, and that the third ceiling raises instead of narrowing.
    Narrowing would be the worst available outcome -- it would file content a
    writer marked intimate under a depth they never chose, and every downstream
    guard would see a well-formed request.
    """
    translated = {
        wire_ceiling_for(ceiling).value
        for ceiling in VaultTierCeiling
        if ceiling.value in _PUBLISHED_WIRE_CEILINGS
    }
    assert translated == set(_PUBLISHED_WIRE_CEILINGS)

    with pytest.raises(CreekCeilingUnrepresentableError):
        wire_ceiling_for(VaultTierCeiling.INTIMATE)


@pytest.mark.asyncio
async def test_a_journal_upsert_puts_an_explicit_tier_on_the_wire(
    vault_clients: ClientFactory,
) -> None:
    """The write the client actually sends carries the field the schema demands.

    The schema test above proves the server refuses a tier-less write; this
    proves adepthood never asks it to. Asserted on the body that left the
    process, so a future refactor that reintroduced an omitted-means-open path
    fails here rather than in Creek's logs.
    """
    sent: list[Mapping[str, object]] = []

    def _capture(request: httpx.Request) -> httpx.Response:
        """Answer the ratified journal exchange, recording each non-handshake body."""
        if request.url.path == _CAPABILITIES_PATH:
            return httpx.Response(
                HTTPStatus.OK, json=_read_json("examples/capabilities/success.json")
            )
        body = json.loads(request.content)
        assert isinstance(body, dict)
        sent.append(body)
        return httpx.Response(
            HTTPStatus.OK, json=_read_json("examples/journal-upsert/success.json")
        )

    client = vault_clients(_capture)
    await client.handshake()
    await client.ingest(_ingest_request())

    assert [body[_TIER_FIELD] for body in sent] == [VaultTierCeiling.PERSONAL.value]


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
