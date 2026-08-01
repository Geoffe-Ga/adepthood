"""Fail the gate when Adepthood's vendored copy of Creek's /v1 contract stops matching.

Creek publishes its ``/v1`` contract as a directory of generated files plus a
``manifest.json`` recording a sha256 for each of them. Adepthood vendors that
directory by copy, pinned to one upstream commit, and the conformance suite in
``tests/test_creek_contract_conformance.py`` reads every wire shape it asserts
out of that copy. A copy-and-pin integration has exactly one failure mode worth
automating against: the copy silently stops describing the server. The suite
stays green, the client goes on agreeing with a document nobody serves any
more, and the divergence surfaces in production instead of in review.

Two questions are asked separately, because they fail for different reasons and
have different remedies. :func:`verify_local` asks whether our own vendored
bytes still hash to the digests recorded in ``vendor.json`` -- an offline,
network-free integrity check that catches a hand-edit, a bad merge, or a
truncating checkout. :func:`compare_upstream` asks whether Creek still publishes
the bytes we vendored, which is the actual drift question and the only one that
needs a remote answer.

The constraint that shapes every branch below is that this check must never
fail open. Upstream is untrusted input that turns into filesystem reads and log
lines, so a fetch that raised, a body that is not JSON, a body larger than
:data:`MAX_FILE_BYTES`, a manifest with no entries, an entry whose path or
digest cannot be trusted, and a run that ended up comparing nothing are each
reported as "cannot verify" rather than as "clean". Reporting success for a run
that proved nothing is the one outcome worse than reporting drift, because it
manufactures confidence in a pin that may no longer be a pin.

Usage:

    python -m scripts.creek_contract_drift verify                  # offline
    python -m scripts.creek_contract_drift compare                 # fetches upstream
    python -m scripts.creek_contract_drift snapshot --commit <sha>  # re-cut the sidecar

Exit codes:
    0 -- every compared file matched the digest recorded for it.
    1 -- at least one file's bytes moved, upstream or on disk.
    2 -- the comparison could not be completed: an unreachable or untrustworthy
        upstream, a manifest that could not be parsed, or nothing to compare at
        all. No drift was proven, but none was ruled out either.
    Both non-zero codes fail the gate; the split exists only to tell an operator
    whether to re-vendor the bundle or to go and find out why the check could
    not run.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

import httpx

EXIT_CLEAN = 0
EXIT_DRIFT = 1
EXIT_UNVERIFIABLE = 2

MANIFEST_NAME = "manifest.json"
README_NAME = "README.md"
VENDOR_NAME = "vendor.json"

_BACKEND_ROOT = Path(__file__).resolve().parent.parent
BUNDLE_ROOT = _BACKEND_ROOT / "tests" / "fixtures" / "creek_v1"

UPSTREAM_REPO = "Geoffe-Ga/creek-vault"
UPSTREAM_PATH = "docs/contracts/adepthood-v1"
UPSTREAM_REF = "main"
_RAW_CONTENT_HOST = "https://raw.githubusercontent.com"

# Bounds on untrusted upstream input. Both are ten-times headroom over the
# published bundle (47 files, largest ~11 KiB), which is wide enough that a
# clean fetch never trips them and narrow enough that a hostile or broken
# upstream cannot decide how much memory this gate spends.
MAX_BUNDLE_FILES = 512
MAX_FILE_BYTES = 1024 * 1024

# Generous enough for a cold CDN edge, finite enough that a hung connection
# fails the scheduled job rather than occupying a runner until it is killed.
FETCH_TIMEOUT_SECONDS = 30.0

# Creek's manifest covers neither itself nor the hand-written README, so those
# two are the only files a comparison has to fetch by name; the manifest's own
# entries cover the other 45.
_DIRECTLY_FETCHED = (MANIFEST_NAME, README_NAME)

# ``examples/<capability>/<state>.json`` is the only path shape that names a
# capability. Schemas, the retry policy, the manifest and the README do not.
_EXAMPLES_DIRECTORY = "examples"
_EXAMPLE_PATH_SEGMENTS = 3
_CAPABILITY_SEGMENT = 1
_PATH_SEPARATOR = "/"

_HEX_DIGEST = re.compile(r"[0-9a-f]{64}")
_PARENT_SEGMENT = ".."
_WINDOWS_SEPARATOR = "\\"
_HTTPS_SCHEME = "https://"

_ABSENT_DIGEST = "(absent)"
_NO_CAPABILITY = "no capability"

_EMPTY_REASON = "the manifest was empty"
_NOT_JSON_REASON = "the manifest was not JSON"
_NOT_AN_OBJECT_REASON = "the manifest was not a JSON object"
_NO_FILE_LIST_REASON = "the manifest carried no file list"
_EMPTY_FILE_LIST_REASON = "the manifest listed no files, so it can only agree vacuously"
_TOO_MANY_FILES_REASON = f"the manifest listed more than {MAX_BUNDLE_FILES} files"
_NOT_AN_ENTRY_REASON = "is not an object"
_UNTRUSTED_PATH_REASON = "carries a path this checker will not turn into a read"
_NOT_A_DIGEST_REASON = "carries something that is not a 64-character lowercase sha256"

_FETCH_FAILED_REASON = "the fetch failed, so nothing about this file was proven"
_OVERSIZED_REASON = f"the body exceeded {MAX_FILE_BYTES} bytes and was refused before being parsed"
_INSECURE_URL_REASON = "refusing to fetch a contract file over anything but HTTPS"

_REMEDIATION_COMMAND = "python -m scripts.creek_contract_drift snapshot --commit <sha>"
_REMEDIATION = (
    "Fix: re-vendor the bundle at the new upstream commit, regenerate the "
    f"sidecar with `{_REMEDIATION_COMMAND}`, and re-run the conformance suite."
)
_NOTHING_VERIFIED = (
    "Cannot verify the Creek contract bundle: nothing was compared, so no drift "
    "was found and none was ruled out.\n"
)

_VERIFY_COMMAND = "verify"
_COMPARE_COMMAND = "compare"
_SNAPSHOT_COMMAND = "snapshot"

# Everything a fetcher is allowed to fail with. A fetch that failed for any
# reason has proven nothing about upstream, so every one of these lands in the
# same "cannot verify" bucket; the tuple is spelled out rather than caught
# blindly so an unexpected failure still surfaces as a traceback.
_FETCH_FAILURES = (OSError, RuntimeError, ValueError, httpx.HTTPError)

Fetcher = Callable[[str], bytes]


class ManifestError(ValueError):
    """A manifest could not be trusted enough to compare anything against."""


class UpstreamFetchError(RuntimeError):
    """One upstream file could not be fetched under this checker's own rules."""


@dataclass(frozen=True)
class VendoredFile:
    """One file a manifest records, by bundle-relative path and sha256 digest."""

    path: str
    sha256: str


@dataclass(frozen=True)
class BundleManifest:
    """A parsed manifest: the versions it names and the files it records.

    ``source_commit`` is populated only by our own ``vendor.json`` sidecar,
    which is what makes the vendored copy a pin; Creek's ``manifest.json``
    describes a directory rather than a revision and leaves it ``None``. The two
    version strings are carried for the operator's benefit and are optional for
    the same reason -- only the digest set is load-bearing here.
    """

    contract_version: str | None
    ontology_version: str | None
    source_commit: str | None
    files: tuple[VendoredFile, ...]


@dataclass(frozen=True)
class Change:
    """One file whose digest disagrees with the digest we recorded for it.

    ``vendored`` is always the digest *we* recorded in ``vendor.json`` and
    ``upstream`` is always the digest observed on the other side of the
    comparison -- which is the on-disk bytes for :func:`verify_local` and
    Creek's published bytes for :func:`compare_upstream`. The naming follows the
    question being asked ("does the other side still agree with our record?")
    rather than the source of the bytes, so a local verification does put an
    on-disk digest in ``upstream``.

    ``vendored is None`` means a file exists that nobody recorded; ``upstream is
    None`` means a recorded file is gone. Both are drift: a vendored bundle is a
    pin only while its file set is exactly the set that was pinned.
    """

    capability: str | None
    path: str
    vendored: str | None
    upstream: str | None


@dataclass(frozen=True)
class Unverifiable:
    """A file the checker could not compare at all, and why.

    The reason never quotes bytes that came from upstream. A rejected path is
    described by its position in the manifest instead, so a hostile manifest
    cannot choose what this gate writes into a CI log.
    """

    path: str
    reason: str


@dataclass(frozen=True)
class DriftReport:
    """The full outcome of one run: what was compared, what moved, what could not be read."""

    compared: int
    changes: tuple[Change, ...]
    unverifiable: tuple[Unverifiable, ...]

    @property
    def exit_code(self) -> int:
        """Return the process exit code for this report."""
        return _grade(self)


def _grade(report: DriftReport) -> int:
    """Decide a report's exit code, with proven drift outranking uncertainty.

    Args:
        report: The report to grade.

    Returns:
        ``EXIT_DRIFT`` when any file moved, ``EXIT_UNVERIFIABLE`` when anything
        could not be read -- including when nothing was compared at all, since
        having checked nothing must never be reported the same way as having
        checked everything and found it sound -- and ``EXIT_CLEAN`` only when
        real files were compared and every one of them held.
    """
    if report.changes:
        return EXIT_DRIFT
    if report.unverifiable or not report.compared:
        return EXIT_UNVERIFIABLE
    return EXIT_CLEAN


def _sha256(data: bytes) -> str:
    """Return the lowercase hex sha256 of ``data``."""
    return hashlib.sha256(data).hexdigest()


def _capability_of(path: str) -> str | None:
    """Return the capability a bundle path names, or ``None`` when it names none.

    Args:
        path: A bundle-relative path.

    Returns:
        The ``<capability>`` segment of ``examples/<capability>/<state>.json``.
        Schemas, the retry policy, the manifest and the README describe the
        contract as a whole rather than one capability, so they yield ``None``.
    """
    segments = path.split(_PATH_SEPARATOR)
    if len(segments) == _EXAMPLE_PATH_SEGMENTS and segments[0] == _EXAMPLES_DIRECTORY:
        return segments[_CAPABILITY_SEGMENT]
    return None


def _is_printable_ascii(text: str) -> bool:
    """Return whether a string is non-empty printable ASCII.

    A generated bundle emits neither a non-ASCII nor a non-printable name, so
    anything else is either a mistake or an attempt to smuggle a control
    character through a path that becomes a log line.
    """
    return bool(text) and text.isascii() and text.isprintable()


def _is_contained_path(path: str) -> bool:
    """Return whether a path stays inside the bundle on every platform we run on.

    Absolute paths and parent-directory references climb out of the bundle, and
    a backslash is a directory separator on one of those platforms even though
    it is an ordinary character on the others.
    """
    return (
        _WINDOWS_SEPARATOR not in path
        and _PARENT_SEGMENT not in path
        and not path.startswith(_PATH_SEPARATOR)
    )


def _is_safe_relative_path(path: str) -> bool:
    """Return whether a manifest path is safe to turn into a filesystem read.

    Args:
        path: A path string taken straight out of an untrusted manifest.

    Returns:
        ``True`` only for a printable-ASCII path that stays inside the bundle.
    """
    return _is_printable_ascii(path) and _is_contained_path(path)


def _entry_reason(index: int, problem: str) -> str:
    """Describe a refused manifest entry by position rather than by content.

    Args:
        index: The zero-based position of the entry within the file list.
        problem: What was wrong with it.

    Returns:
        A message naming the position and the problem. The entry's own bytes are
        deliberately not interpolated: they are untrusted, and this string ends
        up in a CI log.
    """
    return f"manifest entry {index} {problem}"


def _optional_text(value: object) -> str | None:
    """Return ``value`` when it is a string, otherwise ``None``."""
    return value if isinstance(value, str) else None


def _source_commit(source: object) -> str | None:
    """Return the pinned commit a manifest's ``source`` block records, if any.

    Args:
        source: The manifest's ``source`` value, of whatever shape it had.

    Returns:
        The recorded commit sha for our sidecar; ``None`` for Creek's manifest,
        which carries no source block at all.
    """
    if isinstance(source, dict):
        return _optional_text(source.get("commit"))
    return None


def _decode_object(raw: bytes) -> dict[str, object]:
    """Decode manifest bytes into a JSON object, refusing anything else.

    Args:
        raw: The manifest bytes, from disk or from an untrusted fetch.

    Returns:
        The decoded object, with string keys.

    Raises:
        ManifestError: When the bytes are empty, are not JSON, or decode to
            anything other than an object -- an array, a bare string and a proxy
            error page are all refused rather than guessed at.
    """
    if not raw:
        raise ManifestError(_EMPTY_REASON)
    try:
        document: object = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise ManifestError(_NOT_JSON_REASON) from error
    if not isinstance(document, dict):
        raise ManifestError(_NOT_AN_OBJECT_REASON)
    return {str(key): value for key, value in document.items()}


def _entry_path(index: int, entry: Mapping[str, object]) -> str:
    """Return one entry's path, refusing anything this checker will not read.

    Raises:
        ManifestError: When the path is absent, is not a string, or is not a
            contained printable-ASCII relative path.
    """
    path = _optional_text(entry.get("path"))
    if path is None or not _is_safe_relative_path(path):
        raise ManifestError(_entry_reason(index, _UNTRUSTED_PATH_REASON))
    return path


def _entry_digest(index: int, entry: Mapping[str, object]) -> str:
    """Return one entry's sha256, refusing anything that is not one.

    Raises:
        ManifestError: When the digest is absent, is not a string, or is not
            exactly 64 lowercase hex characters. A digest that is not a digest
            can only ever compare unequal or crash, so it is refused up front.
    """
    digest = _optional_text(entry.get("sha256"))
    if digest is None or not _HEX_DIGEST.fullmatch(digest):
        raise ManifestError(_entry_reason(index, _NOT_A_DIGEST_REASON))
    return digest


def _parse_entry(index: int, entry: object) -> VendoredFile:
    """Validate one manifest entry into a path and a digest.

    Args:
        index: The entry's zero-based position, used to describe a refusal.
        entry: The raw entry, of whatever shape the manifest carried.

    Returns:
        The validated :class:`VendoredFile`.

    Raises:
        ManifestError: When the entry is not an object, or when either of its
            two fields is one this checker declines to trust.
    """
    if not isinstance(entry, dict):
        raise ManifestError(_entry_reason(index, _NOT_AN_ENTRY_REASON))
    return VendoredFile(path=_entry_path(index, entry), sha256=_entry_digest(index, entry))


def _parse_files(value: object) -> tuple[VendoredFile, ...]:
    """Validate a manifest's ``files`` list into vendored-file entries.

    Args:
        value: The manifest's ``files`` value, of whatever shape it had.

    Returns:
        One :class:`VendoredFile` per entry, in manifest order.

    Raises:
        ManifestError: When the file list is absent, is not a list, is empty --
            an emptied manifest would otherwise "match" by having nothing to
            disagree with -- or lists more files than a bundle can hold.
    """
    if not isinstance(value, list):
        raise ManifestError(_NO_FILE_LIST_REASON)
    if not value:
        raise ManifestError(_EMPTY_FILE_LIST_REASON)
    if len(value) > MAX_BUNDLE_FILES:
        raise ManifestError(_TOO_MANY_FILES_REASON)
    return tuple(_parse_entry(index, entry) for index, entry in enumerate(value))


def parse_manifest(raw: bytes) -> BundleManifest:
    """Parse manifest bytes into a manifest this checker is willing to trust.

    The same parser reads Creek's published ``manifest.json``, our own
    ``vendor.json`` sidecar, and whatever an upstream fetch happened to return,
    so every validation rule applies to all three. That is deliberate: the
    untrusted case is the one that matters, and giving it a separate, laxer path
    is how a hostile manifest gets read by accident.

    Args:
        raw: The manifest bytes.

    Returns:
        The parsed :class:`BundleManifest`.

    Raises:
        ManifestError: When the bytes are not a JSON object carrying a non-empty,
            bounded list of entries whose paths and digests are all trustworthy.
    """
    document = _decode_object(raw)
    return BundleManifest(
        contract_version=_optional_text(document.get("contract_version")),
        ontology_version=_optional_text(document.get("ontology_version")),
        source_commit=_source_commit(document.get("source")),
        files=_parse_files(document.get("files")),
    )


def load_vendor_manifest(root: Path = BUNDLE_ROOT) -> BundleManifest:
    """Read the sidecar recording what was vendored, and from which commit.

    Args:
        root: The vendored bundle directory.

    Returns:
        The parsed sidecar, covering all 47 vendored files.

    Raises:
        ManifestError: When the sidecar is unreadable as a manifest. This one is
            a committed file of ours rather than untrusted input, so a broken
            sidecar is a broken checkout and raises instead of degrading into a
            finding.
    """
    return parse_manifest((root / VENDOR_NAME).read_bytes())


def load_upstream_manifest(root: Path = BUNDLE_ROOT) -> BundleManifest:
    """Read the vendored copy of Creek's own manifest, without touching a network.

    Args:
        root: The vendored bundle directory.

    Returns:
        The parsed manifest, covering the 45 generated files it records -- it
        covers neither itself nor the hand-written README.

    Raises:
        ManifestError: When the vendored manifest is unreadable as a manifest.
    """
    return parse_manifest((root / MANIFEST_NAME).read_bytes())


def _recorded_digests(root: Path) -> dict[str, str]:
    """Return the ``path -> sha256`` mapping our sidecar recorded."""
    return {item.path: item.sha256 for item in load_vendor_manifest(root).files}


def _disk_digests(root: Path) -> dict[str, str]:
    """Return the ``path -> sha256`` mapping of every bundle file on disk.

    Args:
        root: The bundle directory to walk.

    Returns:
        A mapping keyed by bundle-relative POSIX path. The sidecar excludes
        itself: it is the record, not the record's subject.
    """
    return {
        path.relative_to(root).as_posix(): _sha256(path.read_bytes())
        for path in sorted(root.rglob("*"))
        if path.is_file() and path.name != VENDOR_NAME
    }


def _compare_digests(
    recorded: Mapping[str, str],
    observed: Mapping[str, str],
    unobtainable: frozenset[str],
) -> tuple[int, tuple[Change, ...]]:
    """Compare what we recorded against what the other side actually has.

    Args:
        recorded: The ``path -> sha256`` mapping from our sidecar.
        observed: The ``path -> sha256`` mapping observed on the other side.
        unobtainable: Paths that could not be observed at all. They are excluded
            from the "recorded but gone" set, because a file we failed to read
            is unverified rather than deleted, and calling it deleted would turn
            an outage into a false drift alarm.

    Returns:
        A ``(compared, changes)`` pair. Every observed path counts as compared,
        as does every recorded path the other side no longer has -- a shrinking
        comparison is exactly the silent failure this gate exists to catch.
    """
    changes = [
        Change(
            capability=_capability_of(path),
            path=path,
            vendored=recorded.get(path),
            upstream=digest,
        )
        for path, digest in sorted(observed.items())
        if recorded.get(path) != digest
    ]
    gone = sorted(recorded.keys() - observed.keys() - unobtainable)
    changes.extend(
        Change(
            capability=_capability_of(path),
            path=path,
            vendored=recorded[path],
            upstream=None,
        )
        for path in gone
    )
    return len(observed) + len(gone), tuple(changes)


def verify_local(root: Path = BUNDLE_ROOT) -> DriftReport:
    """Check the vendored bytes on disk against the digests we recorded for them.

    Offline and network-free: this is the half of the gate that catches a
    hand-edit, a bad merge, or a truncating checkout, and it is cheap enough to
    run unconditionally.

    Args:
        root: The vendored bundle directory.

    Returns:
        A report comparing every recorded path against disk *and* every on-disk
        file against the record, so an unlisted file is drift just as much as a
        changed one.
    """
    compared, changes = _compare_digests(
        _recorded_digests(root),
        _disk_digests(root),
        frozenset(),
    )
    return DriftReport(compared=compared, changes=changes, unverifiable=())


def upstream_url(name: str) -> str:
    """Return the raw-content URL Creek publishes one bundle file at.

    Args:
        name: A bundle-relative path.

    Returns:
        The ``raw.githubusercontent.com`` URL for that file at
        :data:`UPSTREAM_REF`. The comparison deliberately reads the branch and
        not the pinned commit: asking whether the pin still matches what Creek
        publishes *today* is the whole question.
    """
    return f"{_RAW_CONTENT_HOST}/{UPSTREAM_REPO}/{UPSTREAM_REF}/{UPSTREAM_PATH}/{name}"


def fetch_upstream_file(url: str) -> bytes:
    """Fetch one file from Creek's public repository over HTTPS.

    Kept as a module-level function rather than inlined into
    :func:`compare_upstream` so the CLI's network seam has a name that tests can
    substitute; an inline request would make the compare subcommand untestable
    offline. creek-vault is public, so the request carries no credential.

    Args:
        url: The URL to fetch, as built by :func:`upstream_url`.

    Returns:
        The response body.

    Raises:
        UpstreamFetchError: When the URL is not HTTPS, or when the body exceeds
            :data:`MAX_FILE_BYTES`. Redirects are not followed, because a
            redirect away from the raw-content host is a change of publisher
            rather than a detail of transport.
        httpx.HTTPError: When the request fails or the status is not a success.
    """
    if not url.startswith(_HTTPS_SCHEME):
        raise UpstreamFetchError(_INSECURE_URL_REASON)
    response = httpx.get(url, follow_redirects=False, timeout=FETCH_TIMEOUT_SECONDS)
    response.raise_for_status()
    content = response.content
    if len(content) > MAX_FILE_BYTES:
        raise UpstreamFetchError(_OVERSIZED_REASON)
    return content


def _fetch_body(name: str, fetch: Fetcher) -> bytes | Unverifiable:
    """Fetch one upstream file, turning any failure into an unverifiable finding.

    Args:
        name: The bundle-relative path to fetch.
        fetch: The injected fetcher.

    Returns:
        The body, or an :class:`Unverifiable` naming why it could not be used.
        The size bound is applied here as well as inside the real fetcher, so an
        injected fetcher cannot hand this checker an unbounded body either. Only
        the exception's type is reported: the message may carry bytes chosen by
        whatever answered, and this text ends up in a CI log.
    """
    try:
        body = fetch(upstream_url(name))
    except _FETCH_FAILURES as error:
        return Unverifiable(path=name, reason=f"{_FETCH_FAILED_REASON} ({type(error).__name__})")
    if len(body) > MAX_FILE_BYTES:
        return Unverifiable(path=name, reason=_OVERSIZED_REASON)
    return body


def _fetch_directly(fetch: Fetcher) -> dict[str, bytes | Unverifiable]:
    """Fetch the two files Creek's manifest cannot cover, one outcome each."""
    return {name: _fetch_body(name, fetch) for name in _DIRECTLY_FETCHED}


def _findings(bodies: Mapping[str, bytes | Unverifiable]) -> list[Unverifiable]:
    """Return the fetch outcomes that produced a finding rather than bytes."""
    return [item for item in bodies.values() if isinstance(item, Unverifiable)]


def _observed_upstream(
    bodies: Mapping[str, bytes | Unverifiable],
    manifest: BundleManifest,
) -> dict[str, str]:
    """Build the upstream ``path -> sha256`` mapping a comparison can be run against.

    Args:
        bodies: The directly fetched files, keyed by name.
        manifest: The parsed upstream manifest.

    Returns:
        A digest per observed path: the two directly fetched files hashed from
        their own bytes, plus the 45 digests the manifest records for everything
        else. Creek's manifest covers neither itself nor the README, which is
        exactly why those two have to be fetched and hashed here.
    """
    observed = {name: _sha256(body) for name, body in bodies.items() if isinstance(body, bytes)}
    observed.update({item.path: item.sha256 for item in manifest.files})
    return observed


def compare_upstream(root: Path = BUNDLE_ROOT, *, fetch: Fetcher) -> DriftReport:
    """Check what Creek publishes today against the digests we vendored.

    Args:
        root: The vendored bundle directory.
        fetch: The seam that produces upstream bytes for a URL. Injected so the
            whole comparison can be exercised over in-memory bodies.

    Returns:
        A report over all 47 vendored files. When the upstream manifest itself
        cannot be obtained or parsed, the comparison is abandoned rather than
        run against a partial picture: the report then says nothing was compared
        instead of reporting the manifest's own mismatch as if it were the
        finding, because an unreadable manifest leaves 45 files unexamined.
    """
    recorded = _recorded_digests(root)
    bodies = _fetch_directly(fetch)
    unverifiable = _findings(bodies)

    manifest = _parse_fetched_manifest(bodies[MANIFEST_NAME], unverifiable)
    if manifest is None:
        return DriftReport(compared=0, changes=(), unverifiable=tuple(unverifiable))

    compared, changes = _compare_digests(
        recorded,
        _observed_upstream(bodies, manifest),
        frozenset(item.path for item in unverifiable),
    )
    return DriftReport(compared=compared, changes=changes, unverifiable=tuple(unverifiable))


def _parse_fetched_manifest(
    body: bytes | Unverifiable,
    unverifiable: list[Unverifiable],
) -> BundleManifest | None:
    """Parse the fetched manifest, recording a finding instead of raising.

    Args:
        body: The fetched manifest body, or the finding explaining its absence.
        unverifiable: The findings list, appended to in place when the body is
            present but cannot be parsed.

    Returns:
        The parsed manifest, or ``None`` when the comparison cannot proceed.
    """
    if not isinstance(body, bytes):
        return None
    try:
        return parse_manifest(body)
    except ManifestError as error:
        unverifiable.append(Unverifiable(path=MANIFEST_NAME, reason=str(error)))
        return None


def snapshot(root: Path = BUNDLE_ROOT, *, commit: str) -> str:
    """Render the sidecar that records what was vendored, without writing anything.

    The bundle name and both version strings are read out of Creek's own
    manifest rather than retyped, so the sidecar cannot claim a version the
    bundle does not carry.

    Args:
        root: The vendored bundle directory.
        commit: The upstream commit sha the bundle was fetched at. A branch name
            would let the "pinned" copy move underneath the digests that are the
            only thing making it a pin, so the caller must supply a sha.

    Returns:
        The sidecar's exact text, for the operator to commit verbatim. Writing
        is left to the caller: snapshotting is a pure read, and a checker that
        silently rewrites the record it checks against is no longer a checker.
    """
    document = _decode_object((root / MANIFEST_NAME).read_bytes())
    payload = {
        "bundle": document.get("bundle"),
        "contract_version": document.get("contract_version"),
        "ontology_version": document.get("ontology_version"),
        "source": {"repo": UPSTREAM_REPO, "commit": commit, "path": UPSTREAM_PATH},
        "files": [
            {"path": path, "sha256": digest} for path, digest in sorted(_disk_digests(root).items())
        ],
    }
    return json.dumps(payload, indent=2, sort_keys=True) + "\n"


def _digest_text(value: str | None) -> str:
    """Render a digest, naming its absence rather than printing ``None``."""
    return value if value is not None else _ABSENT_DIGEST


def _capability_text(value: str | None) -> str:
    """Render a capability name, naming its absence rather than printing ``None``."""
    return value if value is not None else _NO_CAPABILITY


def _change_lines(changes: tuple[Change, ...]) -> list[str]:
    """Render the drift section, naming each file's capability and both digests.

    Args:
        changes: The files whose digests disagree.

    Returns:
        The rendered lines, without trailing newlines.
    """
    verb = "file does" if len(changes) == 1 else "files do"
    lines = [f"Creek contract drift: {len(changes)} vendored {verb} not match the record."]
    lines.extend(
        f"  {item.path} ({_capability_text(item.capability)}): "
        f"recorded {_digest_text(item.vendored)} / observed {_digest_text(item.upstream)}"
        for item in changes
    )
    lines.append(_REMEDIATION)
    return lines


def _unverifiable_lines(unverifiable: tuple[Unverifiable, ...]) -> list[str]:
    """Render the could-not-verify section, naming each file and its reason.

    Args:
        unverifiable: The files that could not be compared.

    Returns:
        The rendered lines, without trailing newlines.
    """
    count = len(unverifiable)
    lines = [f"Cannot verify the Creek contract bundle: {count} file(s) were not compared."]
    lines.extend(f"  {item.path}: {item.reason}" for item in unverifiable)
    return lines


def _finding_lines(report: DriftReport) -> list[str]:
    """Render every non-empty finding section, in severity order.

    Args:
        report: The report to render.

    Returns:
        The rendered lines, empty when the run found nothing at all.
    """
    lines: list[str] = []
    if report.changes:
        lines.extend(_change_lines(report.changes))
    if report.unverifiable:
        lines.extend(_unverifiable_lines(report.unverifiable))
    return lines


def render_report(report: DriftReport) -> str:
    """Render a report as the operator-facing text the gate prints.

    Args:
        report: The report to render.

    Returns:
        A newline-terminated block. A clean run names how many files were
        actually compared, so "compared nothing" can never read the same as
        "compared everything and found it sound" -- and a run with nothing to
        compare says exactly that instead of borrowing the clean wording.
    """
    lines = _finding_lines(report)
    if lines:
        return "\n".join(lines) + "\n"
    if not report.compared:
        return _NOTHING_VERIFIED
    return (
        f"Creek contract drift: none. {report.compared} vendored file(s) "
        "match the recorded digests.\n"
    )


def _build_parser() -> argparse.ArgumentParser:
    """Build the subcommand parser.

    Returns:
        A parser whose subcommand is required, so an unrecognised or missing
        one fails the gate rather than defaulting into a check the operator did
        not ask for.
    """
    parser = argparse.ArgumentParser(description="Check the vendored Creek /v1 contract bundle.")
    subcommands = parser.add_subparsers(dest="command", required=True)
    subcommands.add_parser(_VERIFY_COMMAND, help="check the vendored bytes against vendor.json")
    subcommands.add_parser(
        _COMPARE_COMMAND, help="check Creek's published bytes against vendor.json"
    )
    cut = subcommands.add_parser(_SNAPSHOT_COMMAND, help="render a fresh vendor.json on stdout")
    cut.add_argument("--commit", required=True, help="the upstream commit sha being vendored")
    return parser


def _check(command: str) -> DriftReport:
    """Run the drift check the subcommand names.

    Args:
        command: The parsed subcommand.

    Returns:
        The resulting report. ``fetch_upstream_file`` is resolved as a module
        global here rather than bound as a default argument, so substituting the
        module attribute redirects the CLI's only network call.
    """
    if command == _COMPARE_COMMAND:
        return compare_upstream(BUNDLE_ROOT, fetch=fetch_upstream_file)
    return verify_local(BUNDLE_ROOT)


def main(argv: Sequence[str] | None = None) -> int:
    """Run one subcommand and return its process exit code.

    Args:
        argv: The command-line arguments after the program name. ``None`` reads
            ``sys.argv``.

    Returns:
        ``EXIT_CLEAN`` for the snapshot subcommand, which only renders text,
        otherwise the report's exit code. The report goes to stdout when clean
        and to stderr otherwise, so a failing gate's output is unambiguous.
    """
    args = _build_parser().parse_args(argv)
    if args.command == _SNAPSHOT_COMMAND:
        sys.stdout.write(snapshot(BUNDLE_ROOT, commit=args.commit))
        return EXIT_CLEAN
    report = _check(args.command)
    stream = sys.stdout if report.exit_code == EXIT_CLEAN else sys.stderr
    stream.write(render_report(report))
    return report.exit_code


if __name__ == "__main__":  # pragma: no cover — exercised via tests/CLI
    sys.exit(main(sys.argv[1:]))
