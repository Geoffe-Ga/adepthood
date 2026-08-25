r"""Re-run the evidence an issue cites, so a stale premise reports itself.

Issues in this repo are unusually good: they cite ``path:line``, they paste the
``grep`` that proved the finding, they quote the code. Nothing ever re-ran those
citations, and the backlog decays faster than it is groomed. On 2026-08-22 five
issues in a single day — four of them P0/P1 — carried premises that were already
false at HEAD, and two were caught only because a human re-ran their greps by
hand. This module is the mechanical form of that hand-check.

It is the automated pre-pass for ``prompts/audits/contract-drift-audit.md`` and
deliberately reuses that audit's taxonomy rather than inventing a second one: the
audit's "stale file/symbol/line references" and "counts/baselines wrong" rows are
exactly the two claim kinds implemented here. Everything the audit reserves for a
human — is the premise still *possible* under a ratified contract, is an epic
substantially shipped — stays with the human. This tool only answers the
mechanical question: **does the command the issue quoted still produce the result
the issue quoted?**

Three verdicts, and the third is load-bearing:

``holds``
    Every checkable claim still reproduces.
``expired``
    At least one claim's quoted command no longer produces its quoted result.
``unverifiable``
    Nothing was checkable, or a claim could not be turned into a command. **This
    is not a pass.** A checker that cannot parse an issue's evidence must say so
    loudly; silence that looks like a pass is the failure being fixed here.

Polarity is what makes this safe. Two traps, both recorded on the issue that
commissioned this module, make a naive matcher fail in the dangerous direction —
posting "your premise has expired" on live work:

* An extraction issue's proposed symbol has **not been written yet**, so
  ``grep`` returning nothing *is the premise*, not its expiry.
* A *title* paraphrases a symbol the code spells differently, so a grep for the
  title's wording finds nothing while the code is alive and wired up.

The first is handled by reading the polarity the body itself asserts; the second
by never deriving a claim from anything but the body. The full grep table:

===================  ==================  ==============
Body asserts         Re-run finds        Verdict
===================  ==================  ==============
zero hits            zero hits           ``holds``
zero hits            one or more         ``expired``
one or more hits     zero hits           ``expired``
one or more hits     one or more         ``holds``
polarity unstated    anything            ``unverifiable``
===================  ==================  ==============

Both mismatch directions are ``expired`` because the body quotes *the command's
output*, and a quoted output that no longer reproduces is falsified in either
direction. What is never inferred is the *meaning* of a match — whether new hits
mean the work is done — because that inference is what the traps punish.

**The grep is executed in-process, never shelled out.** Issue bodies are
untrusted text written by many hands and the scheduled job that drives this holds
a write-capable token, so handing quoted body text to a shell is a
command-injection hole. Only a vetted subset is honoured — literal patterns plus
BRE ``\|`` alternation, a whitelist of flags, and a repo-relative path with no
shell metacharacters. Anything outside that subset reports ``unverifiable`` with
the reason, which is the honest answer and also the safe one.

This module performs no network I/O and reads no credentials. The issue list
arrives as JSON on stdin or in a file, and the only durable output is a machine
payload naming the issues that should receive a comment. ``scripts/ralph/
issue-evidence.sh`` owns the ``gh`` transport, so a token or rate-limit failure
surfaces there as a transport error and can never be mistaken for a verdict.

Usage::

    gh issue list --label agent-ready --state open --json number,title,body \
      | python -m scripts.issue_evidence --issues-json - --root .

Exit codes:
    0 — a report was produced and nothing expired.
    1 — at least one issue's premise expired. Advisory only: no gate consumes
        this, because a false ``expired`` must never be able to block a merge.
    2 — the input could not be read or was not a list of issues. No verdict was
        reached, and none is printed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from collections.abc import Iterable, Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

HOLDS = "holds"
EXPIRED = "expired"
UNVERIFIABLE = "unverifiable"

EXIT_CLEAN = 0
EXIT_EXPIRED = 1
EXIT_INPUT = 2

KIND_GREP = "grep"
KIND_PATH_LINE = "path-line"
KIND_QUOTED_LINE = "quoted-line"

MARKER_PREFIX = "<!-- issue-evidence:"
MARKER_DIGEST_LENGTH = 12

# Files larger than this are skipped by the in-process search. Nothing a human
# cites lives in a multi-megabyte generated blob, and reading one would turn a
# seconds-long advisory report into a minutes-long one.
MAX_SEARCHED_BYTES = 2_000_000

# Directories the search never descends into: vendored, generated, or virtual.
# `grep -rn` would read them, but a hit inside node_modules is never the evidence
# an issue meant to cite, and treating one as a match manufactures an `expired`.
SKIPPED_DIRECTORIES = frozenset(
    {
        ".git",
        ".mypy_cache",
        ".pytest_cache",
        ".ralph",
        ".venv",
        "__pycache__",
        "build",
        "coverage",
        "dist",
        "graphify-out",
        "node_modules",
        "venv",
    }
)

# Flags whose semantics the in-process search reproduces exactly. `-v` inverts
# the match and `-w`/`-x` change what counts as one, so a body using them is
# reported unverifiable rather than answered with a different question.
SUPPORTED_GREP_FLAGS = frozenset("rRnilcoqsHh")

# Regex metacharacters that make a pattern more than a literal. `\|` alternation
# is unwrapped before this check, so BRE alternation of literals is supported.
REGEX_METACHARACTERS = frozenset(".*[]^$+?(){}\\")

# Characters that would make a path mean something to a shell. The search never
# uses a shell, but a path carrying these is not a path an issue meant to cite.
UNSAFE_PATH_CHARACTERS = frozenset(";|&$`()<>*?~'\"\n\t \\")

_GREP_RE = re.compile(
    r"grep\s+((?:-{1,2}[A-Za-z-]+\s+)*)"
    r"""(?:"([^"\n]*)"|'([^'\n]*)')"""
    r"\s+([^\s`'\"]+)"
)
_PATH_LINE_RE = re.compile(
    r"(?<![\w/.-])((?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,8}):(\d+)(?:-(\d+))?"
)
_QUOTED_AFTER_CITATION_RE = re.compile(r"[`\s]*(?:[-—:]+)\s*`([^`\n]{8,200})`")
_ZERO_RE = re.compile(
    r"\b(?:zero|no|0)\s+(?:hits|matches|results|occurrences)\b"
    r"|returns?\s+nothing|finds?\s+nothing|matches?\s+nothing"
    r"|\bnothing\b|\bnone\b|is\s+absent|does\s+not\s+exist|not\s+present",
    re.IGNORECASE,
)
_NONZERO_RE = re.compile(
    r"\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+"
    r"(?:hits|matches|results|occurrences)\b"
    r"|still\s+(?:returns|matches|finds)|returns?\s+(?:a\s+)?match",
    re.IGNORECASE,
)
# Underscores are deliberately NOT stripped: markdown italics are rare in these
# bodies and `_` is common in the symbol and file names being quoted, so removing
# it would rewrite `creek_ontology_agent_prompt.md` in the report it prints.
_EMPHASIS_RE = re.compile(r"[*`]+")

# How much text after a grep invocation is read for its asserted polarity. Wide
# enough for "→ **zero hits**. No picker, no drag target"; narrow enough that the
# next bullet's wording cannot bleed in.
POLARITY_WINDOW = 160

# A quoted fragment shorter than this, or with no operator or space in it, is a
# bare identifier rather than a line of code. `_content_params` after a citation
# is a name being discussed, not a line being quoted.
QUOTED_LINE_SHAPE_RE = re.compile(r"[ =(]")


@dataclass(frozen=True)
class Claim:
    """One mechanically re-runnable assertion lifted from an issue body.

    Attributes:
        kind: One of ``KIND_GREP``, ``KIND_PATH_LINE``, ``KIND_QUOTED_LINE``.
        source: The literal body text the claim was read from, quoted back in
            the report so a reader can find it.
        target: Repo-relative search path or cited file.
        pattern: The grep pattern, for ``KIND_GREP``.
        line: The cited line number, for the two citation kinds. A range uses
            its upper bound, which is the strictest thing the file must satisfy.
        expects_matches: The polarity the body asserts for a grep — ``False``
            for "returns nothing", ``True`` for "three hits", ``None`` when the
            body states no result at all.
        quoted: The line of code the body attributes to ``target:line``.
        ignore_case: Whether the invocation carried ``-i``.
    """

    kind: str
    source: str
    target: str = ""
    pattern: str = ""
    line: int = 0
    expects_matches: bool | None = None
    quoted: str = ""
    ignore_case: bool = False


@dataclass(frozen=True)
class ClaimResult:
    """A claim paired with its verdict and the evidence for that verdict."""

    claim: Claim
    verdict: str
    note: str


@dataclass(frozen=True)
class IssueReport:
    """Every claim found in one issue, and the verdict they add up to."""

    number: int
    title: str
    verdict: str
    results: tuple[ClaimResult, ...]
    state: str = "OPEN"
    closed_by_commit: str | None = None

    @property
    def expired(self) -> tuple[ClaimResult, ...]:
        """Return the claims that no longer reproduce."""
        return tuple(r for r in self.results if r.verdict == EXPIRED)

    @property
    def unverifiable(self) -> tuple[ClaimResult, ...]:
        """Return the claims this checker could not turn into a command."""
        return tuple(r for r in self.results if r.verdict == UNVERIFIABLE)

    @property
    def counts(self) -> dict[str, int]:
        """Return per-verdict claim counts, always including every verdict."""
        tally = {HOLDS: 0, EXPIRED: 0, UNVERIFIABLE: 0}
        for result in self.results:
            tally[result.verdict] += 1
        return tally


# ---------------------------------------------------------------------------
# extraction
# ---------------------------------------------------------------------------


def _plain(text: str) -> str:
    """Strip markdown emphasis so ``**zero hits**`` reads as ``zero hits``."""
    return _EMPHASIS_RE.sub("", text)


def _polarity(tail: str) -> bool | None:
    """Read the result an issue body asserts for the grep it just quoted.

    Args:
        tail: Body text immediately following the invocation.

    Returns:
        ``False`` for an asserted empty result, ``True`` for an asserted
        non-empty one, ``None`` when the body asserts neither. ``None`` is
        checked first against the zero vocabulary so "**zero** hits" is not read
        as a hit count.
    """
    window = _plain(tail[:POLARITY_WINDOW])
    if _ZERO_RE.search(window):
        return False
    if _NONZERO_RE.search(window):
        return True
    return None


def _grep_flags(raw: str) -> str:
    """Return the flag letters of an invocation, ``--long`` spellings included."""
    return "".join(token.lstrip("-") for token in raw.split())


def _extract_grep_claims(body: str) -> Iterator[Claim]:
    """Yield one claim per ``grep`` invocation quoted in the body."""
    for match in _GREP_RE.finditer(body):
        flags = _grep_flags(match.group(1))
        pattern = match.group(2) if match.group(2) is not None else match.group(3)
        yield Claim(
            kind=KIND_GREP,
            source=_plain(match.group(0)),
            target=match.group(4).rstrip(".,;"),
            pattern=pattern,
            expects_matches=_polarity(body[match.end() :]),
            ignore_case="i" in flags,
        )


def _top_level_exists(root: Path, target: str) -> bool:
    """Return whether a citation's first path segment names something in-repo.

    ``observability.py:152`` has no directory, so it is not this repo's citation
    and never becomes a claim — the alternative is guessing, and guessing wrong
    here posts a false expiry.
    """
    head = target.split("/", 1)[0]
    return bool(head) and (root / head).exists()


def _extract_path_line_claims(body: str, root: Path) -> Iterator[Claim]:
    """Yield one claim per repo-relative ``path:line`` citation in the body."""
    for match in _PATH_LINE_RE.finditer(body):
        target = match.group(1)
        if not _top_level_exists(root, target):
            continue
        upper = match.group(3) or match.group(2)
        yield Claim(
            kind=KIND_PATH_LINE,
            source=_plain(match.group(0)),
            target=target,
            line=int(upper),
        )


def _looks_like_code_line(text: str) -> bool:
    """Return whether a quoted fragment is a line of code, not a bare name."""
    return bool(QUOTED_LINE_SHAPE_RE.search(text))


def _extract_quoted_line_claims(body: str, root: Path) -> Iterator[Claim]:
    """Yield claims pairing a ``path:line`` citation with the line it quotes."""
    for match in _PATH_LINE_RE.finditer(body):
        target = match.group(1)
        if not _top_level_exists(root, target):
            continue
        quote = _QUOTED_AFTER_CITATION_RE.match(body, match.end())
        if quote is None or not _looks_like_code_line(quote.group(1)):
            continue
        yield Claim(
            kind=KIND_QUOTED_LINE,
            source=f"{match.group(0)} — `{quote.group(1)}`",
            target=target,
            line=int(match.group(2)),
            quoted=quote.group(1).strip(),
        )


def extract_claims(body: str, root: Path) -> list[Claim]:
    """Extract every checkable claim from an issue body.

    Args:
        body: The issue body. **Only** the body — a title paraphrases, and a
            symbol lifted from one may not be the symbol in the code.
        root: Repository root, used to decide whether a cited path is a path
            this repo could own.

    Returns:
        The claims, in body order, deduplicated.
    """
    seen: set[tuple[str, str, str, int, str]] = set()
    claims: list[Claim] = []
    for claim in (
        *_extract_grep_claims(body),
        *_extract_path_line_claims(body, root),
        *_extract_quoted_line_claims(body, root),
    ):
        key = (claim.kind, claim.target, claim.pattern, claim.line, claim.quoted)
        if key in seen:
            continue
        seen.add(key)
        claims.append(claim)
    return claims


# ---------------------------------------------------------------------------
# the in-process search
# ---------------------------------------------------------------------------


def _safe_relative_path(root: Path, target: str) -> Path | None:
    """Resolve a repo-relative citation, or ``None`` if it is not one."""
    if not target or target.startswith("/") or UNSAFE_PATH_CHARACTERS & set(target):
        return None
    candidate = (root / target).resolve()
    if ".." in Path(target).parts or not candidate.is_relative_to(root.resolve()):
        return None
    return root / target


def _alternatives(pattern: str) -> list[str] | None:
    r"""Split a BRE pattern into literal alternatives, or ``None`` if it is not.

    ``journal/upload\|/upload`` becomes two literals. Anything carrying another
    metacharacter is refused rather than approximated, because approximating a
    regex is how a checker invents a match that ``grep`` would not have found.
    """
    parts = pattern.split(r"\|")
    if not pattern or any(not part or REGEX_METACHARACTERS & set(part) for part in parts):
        return None
    return parts


def _searchable_files(base: Path) -> Iterator[Path]:
    """Yield the files a recursive search should read under ``base``."""
    if base.is_file():
        yield base
        return
    for path in sorted(base.rglob("*")):
        if not path.is_file() or SKIPPED_DIRECTORIES & set(path.parts):
            continue
        if path.stat().st_size <= MAX_SEARCHED_BYTES:
            yield path


def _matching_lines(
    base: Path, root: Path, needles: Sequence[str], *, ignore_case: bool
) -> list[str]:
    """Return ``path:line`` for every line matching any literal in ``needles``."""
    wanted = [n.lower() for n in needles] if ignore_case else list(needles)
    hits: list[str] = []
    for path in _searchable_files(base):
        text = path.read_text(encoding="utf-8", errors="replace")
        for number, line in enumerate(text.splitlines(), start=1):
            haystack = line.lower() if ignore_case else line
            if any(needle in haystack for needle in wanted):
                hits.append(f"{path.relative_to(root).as_posix()}:{number}")
    return hits


# ---------------------------------------------------------------------------
# checking
# ---------------------------------------------------------------------------


def _unverifiable(claim: Claim, note: str) -> ClaimResult:
    """Build the honest third verdict, with the reason it was reached."""
    return ClaimResult(claim=claim, verdict=UNVERIFIABLE, note=note)


def _grep_verdict(claim: Claim, hits: Sequence[str]) -> ClaimResult:
    """Compare a re-run's result against the polarity the body asserted."""
    found = len(hits)
    if bool(found) == claim.expects_matches:
        return ClaimResult(claim, HOLDS, f"still {found} matching line(s)")
    if claim.expects_matches:
        return ClaimResult(claim, EXPIRED, "body claims matches; 0 matching lines at HEAD")
    sample = ", ".join(hits[:3])
    return ClaimResult(
        claim,
        EXPIRED,
        f"body claims zero hits; {found} matching line(s) at HEAD — first: {sample}",
    )


def _check_grep(claim: Claim, root: Path) -> ClaimResult:
    """Re-run one quoted ``grep`` in-process and judge the result."""
    if claim.expects_matches is None:
        return _unverifiable(
            claim, "the body states no polarity for this grep — no result to compare"
        )
    needles = _alternatives(claim.pattern)
    if needles is None:
        return _unverifiable(claim, "pattern uses regex syntax beyond literals and BRE alternation")
    unsupported = set(_grep_flags_of(claim)) - SUPPORTED_GREP_FLAGS
    if unsupported:
        return _unverifiable(claim, f"unsupported grep flag(s): {''.join(sorted(unsupported))}")
    base = _safe_relative_path(root, claim.target)
    if base is None:
        return _unverifiable(claim, "search path is not a safe repo-relative path")
    if not base.exists():
        return _unverifiable(claim, "search path does not exist at HEAD — it may name another repo")
    return _grep_verdict(claim, _matching_lines(base, root, needles, ignore_case=claim.ignore_case))


def _grep_flags_of(claim: Claim) -> str:
    """Recover the flag letters from the invocation text stored on the claim."""
    match = _GREP_RE.search(claim.source)
    return _grep_flags(match.group(1)) if match else ""


def _read_lines(path: Path) -> list[str]:
    """Read a cited file as text, replacing anything undecodable."""
    return path.read_text(encoding="utf-8", errors="replace").splitlines()


def _check_path_line(claim: Claim, root: Path) -> ClaimResult:
    """Judge whether a ``path:line`` citation still resolves."""
    path = _safe_relative_path(root, claim.target)
    if path is None:
        return _unverifiable(claim, "citation is not a safe repo-relative path")
    if not path.exists():
        if not path.parent.exists():
            return _unverifiable(
                claim, "cited directory does not exist here — the path likely names another repo"
            )
        return ClaimResult(claim, EXPIRED, "cited file no longer exists")
    total = len(_read_lines(path))
    if claim.line > total:
        return ClaimResult(claim, EXPIRED, f"cited line {claim.line} is past end of file ({total})")
    return ClaimResult(claim, HOLDS, f"file has {total} line(s)")


def _check_quoted_line(claim: Claim, root: Path) -> ClaimResult:
    """Judge whether the line a body quotes still says what it says."""
    path = _safe_relative_path(root, claim.target)
    if path is None or not path.exists():
        return _unverifiable(claim, "cited file is not readable at HEAD")
    lines = _read_lines(path)
    if claim.line > len(lines):
        return _unverifiable(claim, "cited line is past end of file — see the path:line claim")
    if claim.quoted in lines[claim.line - 1]:
        return ClaimResult(claim, HOLDS, "quoted text is still on the cited line")
    elsewhere = [i + 1 for i, line in enumerate(lines) if claim.quoted in line]
    if elsewhere:
        return _unverifiable(claim, f"quoted text moved to line {elsewhere[0]}")
    return ClaimResult(claim, EXPIRED, "quoted text is no longer anywhere in the cited file")


_CHECKERS = {
    KIND_GREP: _check_grep,
    KIND_PATH_LINE: _check_path_line,
    KIND_QUOTED_LINE: _check_quoted_line,
}


def check_claim(claim: Claim, root: Path) -> ClaimResult:
    """Judge a single claim against the working tree at ``root``."""
    try:
        return _CHECKERS[claim.kind](claim, root)
    except OSError as exc:  # pragma: no cover — defensive; a read that fails is not a verdict
        return _unverifiable(claim, f"could not read the cited path: {exc}")


def verdict_for(results: Sequence[ClaimResult]) -> str:
    """Reduce a claim's verdicts to the issue's verdict.

    One expired claim decides the issue. Otherwise an issue is only ``holds``
    when something was actually checked and passed: an issue with no claims, or
    with nothing but unparseable ones, reports ``unverifiable``, because a claim
    the extractor could not run is never counted as a passing claim.
    """
    if any(result.verdict == EXPIRED for result in results):
        return EXPIRED
    if any(result.verdict == HOLDS for result in results):
        return HOLDS
    return UNVERIFIABLE


def check_issue(issue: dict[str, Any], root: Path) -> IssueReport:
    """Check every claim in one issue and return its report.

    Args:
        issue: ``{"number", "title", "body"}``, optionally ``"state"`` and
            ``"closed_by_commit"`` for the closed-but-not-done audit.
        root: Repository root to check the claims against.

    Returns:
        The issue's report. The title is carried for display only and is never
        read for claims.
    """
    body = str(issue.get("body") or "")
    results = tuple(check_claim(claim, root) for claim in extract_claims(body, root))
    return IssueReport(
        number=int(issue["number"]),
        title=str(issue.get("title") or ""),
        verdict=verdict_for(results),
        results=results,
        state=str(issue.get("state") or "OPEN"),
        closed_by_commit=issue.get("closed_by_commit"),
    )


def check_issues(issues: Iterable[dict[str, Any]], root: Path) -> list[IssueReport]:
    """Check a list of issues, preserving input order."""
    return [check_issue(issue, root) for issue in issues]


# ---------------------------------------------------------------------------
# reporting
# ---------------------------------------------------------------------------

_UNVERIFIABLE_LEGEND = (
    "An unverifiable claim is NOT a passing claim — it is one this checker could "
    "not turn into a command. Read them."
)


def _result_lines(report: IssueReport) -> Iterator[str]:
    """Yield the report lines for every non-holding claim of one issue."""
    for result in report.results:
        if result.verdict == HOLDS:
            continue
        yield f"    {result.verdict.upper():<13} {result.claim.kind}: {result.claim.source}"
        yield f"                  {result.note}"


def _verdict_tally(reports: Sequence[IssueReport]) -> dict[str, int]:
    """Count issues per verdict, always including every verdict."""
    return {
        name: sum(1 for report in reports if report.verdict == name)
        for name in (HOLDS, EXPIRED, UNVERIFIABLE)
    }


def render_report(reports: Sequence[IssueReport]) -> str:
    """Render the human-readable advisory report.

    Every expired and every unverifiable claim is named individually: an issue
    that reports ``holds`` while carrying unparseable evidence must still show
    that evidence, or the tool becomes the silence it was built to remove.
    """
    lines = [f"Issue evidence: {len(reports)} issue(s) checked.", ""]
    for report in reports:
        counts = report.counts
        lines.append(
            f"  #{report.number}  {report.verdict:<13}"
            f" holds={counts[HOLDS]} expired={counts[EXPIRED]}"
            f" unverifiable={counts[UNVERIFIABLE]}  {report.title}"
        )
        lines.extend(_result_lines(report))
    tally = _verdict_tally(reports)
    unchecked = sum(len(report.unverifiable) for report in reports)
    summary = (
        f"Summary: {tally[EXPIRED]} expired, {tally[HOLDS]} holds, "
        f"{tally[UNVERIFIABLE]} unverifiable."
    )
    lines += ["", summary, f"Unverifiable claims: {unchecked}. {_UNVERIFIABLE_LEGEND}", ""]
    return "\n".join(lines)


def comment_marker(report: IssueReport) -> str:
    """Return the hidden marker identifying this issue's expired-claim set.

    The digest covers the expired claims themselves, so the marker is stable
    across runs that find the same thing and changes when the finding changes.
    That is what makes the comment fire once per *transition* rather than once
    per run — a bot that re-posts the same finding weekly is noise.
    """
    payload = "\n".join(f"{r.claim.kind}|{r.claim.source}|{r.note}" for r in report.expired)
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:MARKER_DIGEST_LENGTH]
    return f"{MARKER_PREFIX}{digest} -->"


def comment_body(report: IssueReport) -> str:
    """Render the comment posted to an issue whose premise expired."""
    lines = [
        "## An evidence claim in this issue no longer reproduces",
        "",
        "Re-running the citations in this issue's body against `main` at HEAD:",
        "",
    ]
    for result in report.expired:
        lines += [f"- `{result.claim.source}`", f"  - {result.note}", ""]
    epilogue = (
        "This is advisory and read-only: nothing here changed the issue's labels, "
        "body, or state. Re-read the premise before building, and correct the body "
        "if it is wrong — `prompts/audits/contract-drift-audit.md` has the taxonomy."
    )
    lines += [epilogue, "", comment_marker(report)]
    return "\n".join(lines)


def _closed_not_done(reports: Sequence[IssueReport]) -> list[int]:
    """Return closed issues whose close event names no commit and whose claims hold.

    A close by cross-reference from an epic carries a null ``commit_id`` and is
    indistinguishable in any listing from a genuinely-fixed issue. When such an
    issue's own evidence still holds, the work described was very likely never
    done.
    """
    return [
        report.number
        for report in reports
        if report.state.upper() == "CLOSED"
        and report.closed_by_commit is None
        and report.verdict == HOLDS
    ]


def machine_payload(reports: Sequence[IssueReport]) -> dict[str, Any]:
    """Build the JSON the transport script consumes.

    Returns:
        ``comment`` lists only issues that expired, each with the marker the
        transport uses to avoid re-posting; ``closed_not_done`` lists closed
        issues that look undone. Nothing here instructs an edit, a label change,
        or a close — the transport may only ever add a comment.
    """
    return {
        "comment": [
            {
                "number": report.number,
                "marker": comment_marker(report),
                "body": comment_body(report),
            }
            for report in reports
            if report.verdict == EXPIRED
        ],
        "closed_not_done": _closed_not_done(reports),
        "counts": {
            name: sum(1 for report in reports if report.verdict == name)
            for name in (HOLDS, EXPIRED, UNVERIFIABLE)
        },
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


class IssueInputError(Exception):
    """The issue list could not be read, so no verdict was reached.

    Distinct from every verdict on purpose. A ``gh`` failure — rate limit,
    expired token, network — yields an API error object rather than an array,
    and reading that as "no issues, therefore nothing expired" is the
    transport-versus-failure conflation that had to be fixed in ``pr-ready.sh``.
    """


def _load_issues(source: str) -> list[dict[str, Any]]:
    """Read the issue list from stdin or a file.

    Raises:
        IssueInputError: The input was unreadable, was not JSON, or was not a
            list of issues.
    """
    try:
        raw = sys.stdin.read() if source == "-" else Path(source).read_text(encoding="utf-8")
        parsed = json.loads(raw)
    except (OSError, json.JSONDecodeError) as exc:
        raise IssueInputError(f"could not read issue JSON from {source!r}: {exc}") from exc
    if not isinstance(parsed, list):
        raise IssueInputError(f"issue JSON from {source!r} is not a list — the fetch likely failed")
    return parsed


def _build_parser() -> argparse.ArgumentParser:
    """Build the argument parser."""
    parser = argparse.ArgumentParser(description=__doc__, add_help=True)
    parser.add_argument(
        "--issues-json", required=True, help="Path to issue JSON, or '-' for stdin."
    )
    parser.add_argument("--root", default=".", help="Repository root to check claims against.")
    parser.add_argument("--json-out", default="", help="Write the machine payload here.")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Check the issues named on the command line and print the report.

    Args:
        argv: Command-line arguments, ``None`` meaning ``sys.argv[1:]``.

    Returns:
        ``EXIT_CLEAN``, ``EXIT_EXPIRED``, or ``EXIT_INPUT``. An input failure
        prints only the failure: no verdict is printed, because no verdict was
        reached.
    """
    args = _build_parser().parse_args(argv)
    try:
        issues = _load_issues(args.issues_json)
    except IssueInputError as exc:
        sys.stderr.write(f"issue-evidence: {exc}\n")
        return EXIT_INPUT
    reports = check_issues(issues, Path(args.root))
    sys.stdout.write(render_report(reports))
    if args.json_out:
        Path(args.json_out).write_text(
            json.dumps(machine_payload(reports), indent=2), encoding="utf-8"
        )
    return EXIT_EXPIRED if any(r.verdict == EXPIRED for r in reports) else EXIT_CLEAN


if __name__ == "__main__":  # pragma: no cover — exercised via tests and the CLI
    sys.exit(main(sys.argv[1:]))
