"""Tests for ``backend/scripts/creek_contract_drift.py``.

Creek publishes the ``/v1`` contract as a directory of generated files plus a
``manifest.json`` that records a sha256 for each of them. Adepthood vendors that
directory by copy, pinned to one upstream commit. A copy-and-pin integration has
exactly one failure mode worth automating against: the copy silently stops
describing the server. This checker exists to make that loud, and these tests
pin its contract.

Two questions are asked separately, because they fail for different reasons and
have different remedies. ``verify_local`` asks whether our own vendored bytes
still match the digests we recorded when we vendored them -- an offline,
network-free integrity check that catches a hand-edit, a bad merge, or a
truncating checkout. ``compare_upstream`` asks whether Creek still publishes the
bytes we vendored, which is the actual drift question and the one that needs a
remote answer.

Every fetch in this suite is an injected callable over in-memory bytes, so no
test touches a network, and every mutation happens in a ``tmp_path`` copy of the
bundle, so no test edits the vendored fixtures. The remaining contact with real
data is deliberate and is the positive control the whole suite rests on: the
clean cases assert *how many* files were compared, so "clean" can never be
reported by a run that compared nothing.

The checker must never fail open. A fetcher that raises, a body that is not
JSON, a manifest with no entries, an entry whose path or digest cannot be
trusted, and a comparison that ended up comparing nothing are each unverifiable
rather than clean -- reporting success for a run that proved nothing is the one
outcome worse than reporting drift.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import AbstractContextManager, contextmanager
from http import HTTPStatus
from pathlib import Path

import httpx
import pytest

from scripts import creek_contract_drift as drift_module
from scripts.creek_contract_drift import (
    BUNDLE_ROOT,
    EXIT_CLEAN,
    EXIT_DRIFT,
    EXIT_UNVERIFIABLE,
    MAX_BUNDLE_FILES,
    MAX_FILE_BYTES,
    UPSTREAM_PATH,
    UPSTREAM_REF,
    UPSTREAM_REPO,
    Change,
    DriftReport,
    Fetcher,
    ManifestError,
    UpstreamFetchError,
    compare_upstream,
    fetch_upstream_file,
    load_upstream_manifest,
    load_vendor_manifest,
    main,
    parse_manifest,
    render_report,
    snapshot,
    upstream_url,
    verify_local,
)

MANIFEST_NAME = "manifest.json"
README_NAME = "README.md"
VENDOR_NAME = "vendor.json"

BUNDLE_NAME = "adepthood-v1"
CONTRACT_VERSION = "0.2.0"
ONTOLOGY_VERSION = "aptitude-wavelength/2026-05-23"

# The upstream commit the vendored bundle was fetched at. It is the whole point
# of the sidecar: a branch name would let the "pinned" copy move underneath us.
PINNED_COMMIT = "879d9611cb4c3b5599578f39772b906c8c170e02"  # pragma: allowlist secret

# 45 generated files are listed inside Creek's manifest; the manifest and the
# hand-written README are the two it cannot cover, and our sidecar covers all 47.
CREEK_MANIFEST_ENTRIES = 45
VENDORED_FILES = 47

# Two example paths whose drift must name two different capabilities in the
# rendered report, so "a capability is named" cannot pass by naming a constant.
JOURNAL_SUCCESS = "examples/journal-upsert/success.json"
WHEEL_SUCCESS = "examples/wheel/success.json"

# A body no upstream would serve, used to prove a changed byte is detected
# rather than a changed length.
CHANGED_BODY = b'{"changed": true}\n'

# An upper bound on a sane input bound: wide enough for anything Creek would
# publish, narrow enough that an unbounded fetch is still a bug.
SANE_MAX_BUNDLE_FILES = 10_000
SANE_MAX_FILE_BYTES = 16 * 1024 * 1024


class _FetchNotScriptedError(RuntimeError):
    """A fetcher was asked for a URL the test did not script."""


def _sha256(data: bytes) -> str:
    """Return the lowercase hex sha256 of ``data``."""
    return hashlib.sha256(data).hexdigest()


def _vendored_bytes(relative: str) -> bytes:
    """Return the on-disk bytes of one vendored bundle file."""
    return (BUNDLE_ROOT / relative).read_bytes()


def _copy_bundle(tmp_path: Path) -> Path:
    """Copy the vendored bundle into ``tmp_path`` so a test may mutate it freely."""
    destination = tmp_path / "creek_v1"
    shutil.copytree(BUNDLE_ROOT, destination)
    return destination


def _rewrite(root: Path, relative: str, body: bytes) -> None:
    """Overwrite one file inside a bundle copy."""
    (root / relative).write_bytes(body)


def _fetcher(manifest: bytes, readme: bytes) -> Fetcher:
    """Build an offline fetcher answering only the two URLs a comparison needs.

    ``compare_upstream`` needs the upstream manifest and the upstream README;
    the 45 digests inside the fetched manifest cover everything else. Matching on
    the trailing filename keeps this independent of however the module spells the
    raw-content URL, and an unscripted URL raises rather than answering, so a
    comparison that fetched something unexpected cannot look clean.
    """

    def _fetch(url: str) -> bytes:
        """Answer one scripted URL, refusing anything else."""
        if url.endswith(MANIFEST_NAME):
            return manifest
        if url.endswith(README_NAME):
            return readme
        raise _FetchNotScriptedError(url)

    return _fetch


def _vendored_fetcher() -> Fetcher:
    """Build the fetcher that answers with exactly the bytes we vendored."""
    return _fetcher(_vendored_bytes(MANIFEST_NAME), _vendored_bytes(README_NAME))


def _serialise(payload: object) -> bytes:
    """Serialise a manifest exactly as Creek's generator does, trailing newline included.

    Byte-for-byte fidelity matters here: a test that rebuilds the manifest to
    change one digest must leave the manifest's own digest untouched, or every
    such test would report two changes instead of the one it is about.
    """
    return json.dumps(payload, indent=2, sort_keys=True).encode() + b"\n"


def _changed_upstream_fetcher(relative: str) -> Fetcher:
    """Build a fetcher whose manifest reports a different digest for ``relative``."""
    payload = json.loads(_vendored_bytes(MANIFEST_NAME))
    for entry in payload["files"]:
        if entry["path"] == relative:
            entry["sha256"] = _sha256(CHANGED_BODY)
    return _fetcher(_serialise(payload), _vendored_bytes(README_NAME))


def _raising_fetcher() -> Fetcher:
    """Build a fetcher that fails instead of answering, as an offline runner would."""

    def _fetch(url: str) -> bytes:
        """Refuse every URL."""
        raise _FetchNotScriptedError(url)

    return _fetch


def _constant_fetcher(body: bytes) -> Fetcher:
    """Build a fetcher answering every URL with one fixed body."""

    def _fetch(_url: str) -> bytes:
        """Answer with the fixed body."""
        return body

    return _fetch


class _ScriptedStream:
    """A stand-in for the streaming response ``httpx.stream`` yields.

    Records how many chunks were actually pulled, which is what lets a test
    assert the size cap *stopped* a download rather than merely refusing a body
    it had already paid to receive in full.
    """

    def __init__(self, status: int, chunks: Sequence[bytes], url: str) -> None:
        """Store the scripted response and the URL it answers for."""
        self._status = status
        self._chunks = tuple(chunks)
        self._url = url
        self.pulled = 0

    def raise_for_status(self) -> None:
        """Raise the same error httpx would for a non-success status."""
        if self._status >= HTTPStatus.BAD_REQUEST:
            request = httpx.Request("GET", self._url)
            raise httpx.HTTPStatusError(
                f"status {self._status}",
                request=request,
                response=httpx.Response(self._status, request=request),
            )

    def iter_bytes(self) -> Iterator[bytes]:
        """Yield the scripted chunks, counting each one as it is consumed."""
        for chunk in self._chunks:
            self.pulled += 1
            yield chunk


def _stub_stream(stream: _ScriptedStream) -> Callable[..., AbstractContextManager[_ScriptedStream]]:
    """Build a stand-in for ``httpx.stream`` that yields one scripted response."""

    @contextmanager
    def _stream(_method: str, _url: str, **_options: object) -> Iterator[_ScriptedStream]:
        """Yield the scripted response for the duration of the block."""
        yield stream

    return _stream


def _forbidden_stream(_method: str, url: str, **_options: object) -> AbstractContextManager[object]:
    """Stand in for ``httpx.stream`` where no request may be made at all."""
    raise _FetchNotScriptedError(url)


def _entry(path: str, sha256: str) -> dict[str, object]:
    """Build one upstream manifest entry."""
    return {"capability": None, "model": None, "path": path, "sha256": sha256, "state": None}


def _manifest_bytes(files: Sequence[Mapping[str, object]]) -> bytes:
    """Serialise an upstream-shaped manifest carrying ``files``."""
    payload = {
        "bundle": BUNDLE_NAME,
        "contract_version": CONTRACT_VERSION,
        "files": list(files),
        "ontology_version": ONTOLOGY_VERSION,
    }
    return _serialise(payload)


def _only_change(report: DriftReport) -> Change:
    """Return the report's single change, asserting there is exactly one."""
    assert report.unverifiable == (), report.unverifiable
    assert len(report.changes) == 1, report.changes
    return report.changes[0]


def _change_for(report: DriftReport, path: str) -> Change:
    """Return the report's change for ``path``, asserting there is exactly one."""
    assert report.unverifiable == (), report.unverifiable
    matching = [change for change in report.changes if change.path == path]
    assert len(matching) == 1, report.changes
    return matching[0]


def test_exit_code_constants_are_the_documented_shell_codes() -> None:
    """The three codes are the contract between this script and the gate that runs it."""
    assert EXIT_CLEAN == 0
    assert EXIT_DRIFT == 1
    assert EXIT_UNVERIFIABLE == 2


def test_upstream_coordinates_name_the_published_bundle() -> None:
    """A comparison must look where Creek actually publishes the contract."""
    assert UPSTREAM_REPO == "Geoffe-Ga/creek-vault"
    assert UPSTREAM_PATH == "docs/contracts/adepthood-v1"
    assert UPSTREAM_REF == "main"


def test_bundle_root_is_the_vendored_creek_directory() -> None:
    """The default root is the committed bundle, not a path assembled at call time."""
    assert BUNDLE_ROOT.is_dir()
    assert (BUNDLE_ROOT / MANIFEST_NAME).is_file()
    assert (BUNDLE_ROOT / README_NAME).is_file()
    assert BUNDLE_ROOT.name == "creek_v1"


def test_input_bounds_admit_the_real_bundle_and_still_bound_a_hostile_one() -> None:
    """Upstream is untrusted input, so both bounds must be real and both must fit.

    A bound below the published bundle would reject a clean fetch; an unbounded
    one would let a hostile or broken upstream decide how much memory this gate
    spends. The assertions pin both directions rather than the exact numbers.
    """
    largest = max(path.stat().st_size for path in BUNDLE_ROOT.rglob("*") if path.is_file())

    assert VENDORED_FILES <= MAX_BUNDLE_FILES <= SANE_MAX_BUNDLE_FILES
    assert largest <= MAX_FILE_BYTES <= SANE_MAX_FILE_BYTES


def test_verify_local_compares_every_vendored_file_and_finds_no_drift() -> None:
    """The committed bundle matches its own recorded digests, and 47 files prove it.

    The count is the positive control: without it, a run that found no files at
    all would render exactly like a run that verified the whole bundle.
    """
    report = verify_local(BUNDLE_ROOT)

    assert report.compared == VENDORED_FILES
    assert report.changes == ()
    assert report.unverifiable == ()
    assert report.exit_code == EXIT_CLEAN

    rendered = render_report(report)
    assert str(VENDORED_FILES) in rendered
    assert "cannot verify" not in rendered.lower()


def test_verify_local_reports_one_mutated_fixture_and_names_its_capability(
    tmp_path: Path,
) -> None:
    """A single changed byte in one example is drift, attributed to its capability."""
    root = _copy_bundle(tmp_path)
    recorded = _sha256(_vendored_bytes(JOURNAL_SUCCESS))
    _rewrite(root, JOURNAL_SUCCESS, CHANGED_BODY)

    report = verify_local(root)
    change = _only_change(report)

    assert change.path == JOURNAL_SUCCESS
    assert change.capability == "journal-upsert"
    assert change.vendored == recorded
    assert change.upstream == _sha256(CHANGED_BODY)
    assert report.exit_code == EXIT_DRIFT
    assert JOURNAL_SUCCESS in render_report(report)
    assert "journal-upsert" in render_report(report)


def test_verify_local_reports_a_file_nobody_recorded(tmp_path: Path) -> None:
    """An unlisted file is drift too: the vendored set must be exactly what we pinned."""
    root = _copy_bundle(tmp_path)
    added = "examples/journal-upsert/surprise.json"
    _rewrite(root, added, CHANGED_BODY)

    report = verify_local(root)
    change = _only_change(report)

    assert change.path == added
    assert change.vendored is None
    assert change.upstream == _sha256(CHANGED_BODY)
    assert report.exit_code == EXIT_DRIFT
    assert added in render_report(report)


def test_verify_local_reports_a_recorded_file_that_is_gone(tmp_path: Path) -> None:
    """A deleted fixture must fail loudly rather than shrink the comparison silently."""
    root = _copy_bundle(tmp_path)
    recorded = _sha256(_vendored_bytes(WHEEL_SUCCESS))
    (root / WHEEL_SUCCESS).unlink()

    report = verify_local(root)
    change = _only_change(report)

    assert change.path == WHEEL_SUCCESS
    assert change.capability == "wheel"
    assert change.vendored == recorded
    assert change.upstream is None
    assert report.exit_code == EXIT_DRIFT
    assert "wheel" in render_report(report)


def test_compare_upstream_is_clean_when_upstream_serves_the_vendored_bytes() -> None:
    """Two fetches plus the 45 digests inside them cover all 47 vendored files."""
    report = compare_upstream(BUNDLE_ROOT, fetch=_vendored_fetcher())

    assert report.compared == VENDORED_FILES
    assert report.changes == ()
    assert report.unverifiable == ()
    assert report.exit_code == EXIT_CLEAN
    assert str(VENDORED_FILES) in render_report(report)


@pytest.mark.parametrize(
    ("relative", "capability"),
    [(JOURNAL_SUCCESS, "journal-upsert"), (WHEEL_SUCCESS, "wheel")],
)
def test_compare_upstream_names_the_changed_capability(relative: str, capability: str) -> None:
    """A republished example is drift, and the report says which capability moved.

    Two capabilities are exercised so the rendered name cannot be a constant that
    happens to match one of them. Upstream's manifest is reported alongside the
    example, because a real republication moves the manifest's own bytes too --
    that is a second true finding, not noise, and the report must carry both.
    """
    report = compare_upstream(BUNDLE_ROOT, fetch=_changed_upstream_fetcher(relative))
    change = _change_for(report, relative)

    assert {item.path for item in report.changes} == {relative, MANIFEST_NAME}
    assert change.capability == capability
    assert change.vendored == _sha256(_vendored_bytes(relative))
    assert change.upstream == _sha256(CHANGED_BODY)
    assert report.compared == VENDORED_FILES
    assert report.exit_code == EXIT_DRIFT

    rendered = render_report(report)
    assert capability in rendered
    assert relative in rendered


def test_compare_upstream_detects_a_rewritten_upstream_readme() -> None:
    """The README is outside Creek's manifest, so only a direct fetch can catch it."""
    report = compare_upstream(
        BUNDLE_ROOT,
        fetch=_fetcher(_vendored_bytes(MANIFEST_NAME), CHANGED_BODY),
    )
    change = _only_change(report)

    assert change.path == README_NAME
    assert change.capability is None
    assert change.vendored == _sha256(_vendored_bytes(README_NAME))
    assert change.upstream == _sha256(CHANGED_BODY)
    assert report.exit_code == EXIT_DRIFT


def test_compare_upstream_detects_a_reserialised_upstream_manifest() -> None:
    """The manifest's own bytes are compared, not just the digests it carries.

    Upstream is reserialised with different indentation, so all 45 listed digests
    still agree and only the manifest itself moved. Nothing else in the bundle
    can catch that, because nothing else records the manifest's digest.
    """
    reindented = json.dumps(json.loads(_vendored_bytes(MANIFEST_NAME)), indent=4, sort_keys=True)
    reserialised = reindented.encode() + b"\n"

    report = compare_upstream(
        BUNDLE_ROOT,
        fetch=_fetcher(reserialised, _vendored_bytes(README_NAME)),
    )
    change = _only_change(report)

    assert change.path == MANIFEST_NAME
    assert change.vendored == _sha256(_vendored_bytes(MANIFEST_NAME))
    assert change.upstream == _sha256(reserialised)
    assert report.compared == VENDORED_FILES
    assert report.exit_code == EXIT_DRIFT


def test_compare_upstream_reports_a_file_creek_no_longer_publishes() -> None:
    """A path dropped from Creek's manifest is drift, not a smaller clean run.

    Two changes are expected, not one: dropping an entry also moves the
    manifest's own bytes. The second is the point -- a recorded file that
    upstream stopped listing must be named rather than quietly left out of the
    comparison, which is how a shrinking check reports clean.
    """
    payload = json.loads(_vendored_bytes(MANIFEST_NAME))
    payload["files"] = [entry for entry in payload["files"] if entry["path"] != WHEEL_SUCCESS]

    report = compare_upstream(
        BUNDLE_ROOT,
        fetch=_fetcher(_serialise(payload), _vendored_bytes(README_NAME)),
    )
    dropped = report.changes[-1]

    assert [change.path for change in report.changes] == [MANIFEST_NAME, WHEEL_SUCCESS]
    assert dropped.capability == "wheel"
    assert dropped.vendored == _sha256(_vendored_bytes(WHEEL_SUCCESS))
    assert dropped.upstream is None
    assert report.unverifiable == ()
    assert report.compared == VENDORED_FILES
    assert report.exit_code == EXIT_DRIFT


def test_a_file_that_could_not_be_fetched_is_unverified_rather_than_deleted() -> None:
    """An unreachable file is unproven, and calling it deleted would be a false alarm.

    Only the README fails here, so the manifest still covers 45 of the 47. The
    missing one must be reported as unverifiable and subtracted from the
    compared count, never reported as drift -- an upstream outage and an
    upstream deletion are different events with different remedies.
    """

    def _fetch(url: str) -> bytes:
        """Answer only the manifest, as a partial outage would."""
        if url.endswith(MANIFEST_NAME):
            return _vendored_bytes(MANIFEST_NAME)
        raise _FetchNotScriptedError(url)

    report = compare_upstream(BUNDLE_ROOT, fetch=_fetch)

    assert report.changes == ()
    assert [item.path for item in report.unverifiable] == [README_NAME]
    assert report.compared == VENDORED_FILES - 1
    assert report.exit_code == EXIT_UNVERIFIABLE


def test_a_fetcher_that_raises_is_unverifiable_not_clean() -> None:
    """An offline runner proves nothing about upstream, so it must not report clean."""
    report = compare_upstream(BUNDLE_ROOT, fetch=_raising_fetcher())

    assert report.changes == ()
    assert report.unverifiable != ()
    assert report.exit_code == EXIT_UNVERIFIABLE
    assert report.exit_code != EXIT_CLEAN
    assert "cannot verify" in render_report(report).lower()


def test_a_non_json_upstream_body_is_unverifiable_not_clean() -> None:
    """A proxy error page served as the manifest is an unread comparison, not a pass."""
    report = compare_upstream(BUNDLE_ROOT, fetch=_constant_fetcher(b"<html>not json</html>"))

    assert report.changes == ()
    assert report.unverifiable != ()
    assert report.exit_code == EXIT_UNVERIFIABLE
    assert report.exit_code != EXIT_CLEAN


def test_an_upstream_manifest_with_no_entries_is_unverifiable_not_clean() -> None:
    """An emptied manifest would otherwise "match" by having nothing to disagree with."""
    report = compare_upstream(
        BUNDLE_ROOT,
        fetch=_fetcher(_manifest_bytes([]), _vendored_bytes(README_NAME)),
    )

    assert report.exit_code == EXIT_UNVERIFIABLE
    assert report.exit_code != EXIT_CLEAN


def test_an_oversized_upstream_body_is_rejected_rather_than_read() -> None:
    """Upstream is untrusted, so an unbounded body is refused before it is parsed."""
    report = compare_upstream(
        BUNDLE_ROOT,
        fetch=_constant_fetcher(b"x" * (MAX_FILE_BYTES + 1)),
    )

    assert report.changes == ()
    assert report.unverifiable != ()
    assert report.exit_code == EXIT_UNVERIFIABLE
    assert report.exit_code != EXIT_CLEAN


def test_a_comparison_that_compared_nothing_is_unverifiable_not_clean() -> None:
    """Zero compared files proves nothing; reporting it as clean is the fail-open."""
    report = DriftReport(compared=0, changes=(), unverifiable=())

    assert report.exit_code == EXIT_UNVERIFIABLE
    assert report.exit_code != EXIT_CLEAN


def test_render_report_says_nothing_was_verified_rather_than_borrowing_clean_wording() -> None:
    """The empty report must name its own cause, never read like a verified bundle."""
    nothing = render_report(DriftReport(compared=0, changes=(), unverifiable=()))
    clean = render_report(verify_local(BUNDLE_ROOT))

    assert nothing != clean
    assert "nothing" in nothing.lower() or "cannot verify" in nothing.lower()


def test_parse_manifest_reads_creeks_published_manifest() -> None:
    """The vendored manifest parses into its 45 entries and its two version strings."""
    manifest = parse_manifest(_vendored_bytes(MANIFEST_NAME))

    assert manifest.contract_version == CONTRACT_VERSION
    assert manifest.ontology_version == ONTOLOGY_VERSION
    assert manifest.source_commit is None
    assert len(manifest.files) == CREEK_MANIFEST_ENTRIES
    assert {item.path for item in manifest.files} >= {JOURNAL_SUCCESS, WHEEL_SUCCESS}
    assert all(len(item.sha256) == 64 for item in manifest.files)


@pytest.mark.parametrize(
    "path",
    [
        "/absolute/success.json",
        "../escape.json",
        "examples/../../escape.json",
        "examples\\wheel\\success.json",
        "examples/wheel/succ\u00e9ss.json",
        "examples/wheel/su\x00ccess.json",
        "examples/wheel/succ\tess.json",
    ],
)
def test_parse_manifest_refuses_a_path_it_will_not_trust(path: str) -> None:
    """A manifest path becomes a filesystem read, so anything unusual is refused.

    Absolute paths and dot segments climb out of the bundle, a backslash is a
    separator on one of the platforms this runs on, and a non-printable or
    non-ASCII path is not something a generated bundle emits.
    """
    raw = _manifest_bytes([_entry(path, _sha256(CHANGED_BODY))])

    with pytest.raises(ManifestError):
        parse_manifest(raw)


@pytest.mark.parametrize(
    "sha256",
    ["", "not-hex", "A" * 64, "a" * 63, "a" * 65, "a" * 63 + "g"],
)
def test_parse_manifest_refuses_a_digest_that_is_not_64_lowercase_hex(sha256: str) -> None:
    """A digest that is not a digest can only ever compare unequal or crash."""
    raw = _manifest_bytes([_entry("examples/wheel/success.json", sha256)])

    with pytest.raises(ManifestError):
        parse_manifest(raw)


def test_parse_manifest_refuses_more_entries_than_the_bundle_bound() -> None:
    """A manifest listing more files than a bundle can hold is a hostile input."""
    files = [
        _entry(f"schemas/Generated{index}.schema.json", _sha256(CHANGED_BODY))
        for index in range(MAX_BUNDLE_FILES + 1)
    ]

    with pytest.raises(ManifestError):
        parse_manifest(_manifest_bytes(files))


@pytest.mark.parametrize(
    "raw",
    [b"", b"<html>not json</html>", b"[]", b'"a string"', b"{}", b'{"files": {}}'],
)
def test_parse_manifest_refuses_bytes_it_cannot_interpret(raw: bytes) -> None:
    """Anything that is not a manifest object with a file list is refused, not guessed."""
    with pytest.raises(ManifestError):
        parse_manifest(raw)


def test_parse_manifest_refuses_an_entry_that_is_not_an_object() -> None:
    """A file list of scalars is refused outright rather than silently skipped."""
    with pytest.raises(ManifestError):
        parse_manifest(b'{"files": [42]}')


def test_a_refused_manifest_entry_leaves_nothing_compared() -> None:
    """A rejected path must be reported, never used to read a file off disk."""
    raw = _manifest_bytes([_entry("../escape.json", _sha256(CHANGED_BODY))])

    report = compare_upstream(
        BUNDLE_ROOT,
        fetch=_fetcher(raw, _vendored_bytes(README_NAME)),
    )

    assert report.compared == 0
    assert report.changes == ()
    assert report.unverifiable != ()
    assert report.exit_code == EXIT_UNVERIFIABLE


def test_load_vendor_manifest_records_the_pinned_source_commit() -> None:
    """Our sidecar pins a commit sha, which is what makes the vendored copy a pin."""
    manifest = load_vendor_manifest(BUNDLE_ROOT)

    assert manifest.source_commit == PINNED_COMMIT
    assert manifest.contract_version == CONTRACT_VERSION
    assert manifest.ontology_version == ONTOLOGY_VERSION
    assert len(manifest.files) == VENDORED_FILES


def test_load_upstream_manifest_reads_the_vendored_copy_of_creeks_manifest() -> None:
    """Creek's own manifest is read from disk, not refetched, so it stays offline."""
    manifest = load_upstream_manifest(BUNDLE_ROOT)

    assert len(manifest.files) == CREEK_MANIFEST_ENTRIES
    assert manifest.source_commit is None
    assert MANIFEST_NAME not in {item.path for item in manifest.files}
    assert README_NAME not in {item.path for item in manifest.files}


def test_snapshot_round_trips_the_committed_sidecar_exactly() -> None:
    """Regenerating the sidecar at the pinned commit must reproduce it byte for byte.

    This is what makes the re-vendor procedure mechanical: the operator runs the
    snapshot subcommand and commits its output, and this test proves the file in
    the tree is what that command produces rather than something hand-edited.
    """
    assert snapshot(BUNDLE_ROOT, commit=PINNED_COMMIT) == (BUNDLE_ROOT / VENDOR_NAME).read_text()


def test_snapshot_does_not_write_a_file(tmp_path: Path) -> None:
    """Snapshotting is a pure read: the caller decides where the text lands."""
    root = _copy_bundle(tmp_path)
    (root / VENDOR_NAME).unlink()

    text = snapshot(root, commit=PINNED_COMMIT)

    assert not (root / VENDOR_NAME).exists()
    assert json.loads(text)["source"]["commit"] == PINNED_COMMIT


def test_upstream_url_addresses_the_public_raw_content_host() -> None:
    """The comparison reads the branch, because "what does Creek publish now" is the question."""
    assert upstream_url(MANIFEST_NAME) == (
        f"https://raw.githubusercontent.com/{UPSTREAM_REPO}/"
        f"{UPSTREAM_REF}/{UPSTREAM_PATH}/{MANIFEST_NAME}"
    )


def test_fetch_upstream_file_returns_the_body_the_raw_host_served(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The real fetcher is a thin read, exercised here against a stubbed transport.

    The body arrives as several chunks so the reassembly is exercised rather
    than assumed: a fetcher that returned only the first chunk would still hash
    to something, and that something would compare unequal for the wrong reason.
    """
    url = upstream_url(MANIFEST_NAME)
    chunks = [CHANGED_BODY[:4], CHANGED_BODY[4:9], CHANGED_BODY[9:]]
    monkeypatch.setattr(httpx, "stream", _stub_stream(_ScriptedStream(HTTPStatus.OK, chunks, url)))

    assert fetch_upstream_file(url) == CHANGED_BODY


def test_fetch_upstream_file_refuses_a_plaintext_url_before_requesting_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A contract document must not be read off a channel anyone can rewrite.

    The stub raises on any call at all, so the refusal is proven to happen
    before the request rather than after it.
    """
    monkeypatch.setattr(httpx, "stream", _forbidden_stream)

    with pytest.raises(UpstreamFetchError):
        fetch_upstream_file("http://raw.githubusercontent.com/Geoffe-Ga/creek-vault/main/x.json")


def test_fetch_upstream_file_raises_on_an_error_status(monkeypatch: pytest.MonkeyPatch) -> None:
    """A 404 body is not a contract file, so it must not be handed on as one."""
    url = upstream_url(MANIFEST_NAME)
    stream = _ScriptedStream(HTTPStatus.NOT_FOUND, [CHANGED_BODY], url)
    monkeypatch.setattr(httpx, "stream", _stub_stream(stream))

    with pytest.raises(httpx.HTTPStatusError):
        fetch_upstream_file(url)

    assert stream.pulled == 0, "the status must be refused before any body is read"


def test_fetch_upstream_file_stops_an_oversized_download_instead_of_buffering_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The size bound must end the transfer, not merely refuse what already arrived.

    A cap checked only after the whole body is in memory lets a compromised or
    malfunctioning publisher decide how much this process holds, with nothing
    but the timeout to stop it -- so the assertion here is not just that the
    fetcher raised, but that it stopped pulling chunks partway through. The
    scripted body is twice the cap, delivered in eighths.
    """
    url = upstream_url(MANIFEST_NAME)
    chunk_count = 16
    chunk_size = MAX_FILE_BYTES // (chunk_count // 2)
    stream = _ScriptedStream(HTTPStatus.OK, [b"x" * chunk_size] * chunk_count, url)
    monkeypatch.setattr(httpx, "stream", _stub_stream(stream))

    with pytest.raises(UpstreamFetchError):
        fetch_upstream_file(url)

    assert stream.pulled < chunk_count, "the download must be abandoned, not merely rejected"


def test_main_verify_returns_clean_on_the_vendored_bundle(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The verify subcommand is the offline gate check-all can run unconditionally."""
    exit_code = main(["verify"])

    assert exit_code == EXIT_CLEAN
    assert str(VENDORED_FILES) in capsys.readouterr().out


def test_main_compare_drives_the_module_fetch_seam(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The compare subcommand's network call is a named module attribute, not inline.

    Keeping it patchable is what lets the CLI path be exercised without a
    network; an inline request would make this subcommand untestable offline.
    """
    monkeypatch.setattr(drift_module, "fetch_upstream_file", _vendored_fetcher())

    exit_code = main(["compare"])

    assert exit_code == EXIT_CLEAN
    assert str(VENDORED_FILES) in capsys.readouterr().out


def test_main_snapshot_prints_the_sidecar_the_operator_is_to_commit(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The re-vendor procedure is one command whose stdout is the file, verbatim."""
    exit_code = main(["snapshot", "--commit", PINNED_COMMIT])

    assert exit_code == EXIT_CLEAN
    assert capsys.readouterr().out == (BUNDLE_ROOT / VENDOR_NAME).read_text()


def test_main_rejects_an_unknown_subcommand() -> None:
    """An unrecognised subcommand must fail the gate rather than default to a check."""
    try:
        exit_code: object = main(["reticulate"])
    except SystemExit as exit_signal:
        exit_code = exit_signal.code

    assert exit_code != EXIT_CLEAN
