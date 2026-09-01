"""Turn a finished run into text an operator can act on, and into an exit code CI reads.

A finding is only useful if the reader can reproduce it without rerunning
anything, so every failure block names the method, the path template, the exact
id that was sent, whose object it was, the status the server actually returned,
and a curl line that reproduces it in one paste. "IDOR on /journal" is a ticket
nobody can close.

A reference finding carries one fact more than a path finding: which field
carried the id, and whether the object actually surfaced. Without the field the
reader cannot reproduce the request at all, because the path alone does not say
what to send.

The summary block matters just as much on a green run. It states how many routes
were discovered, seeded, left uncovered, and excused, and how many body- or
query-carried ids were probed, so a pass reads as "these routes were genuinely
probed" rather than as an unqualified thumbs-up. Beside it sits the scope note,
which has to describe the check that actually ran: understating a green run
sends the next reader looking for a gap that is not there, and overstating one
is worse.

The exit-code precedence encodes the same idea. A tripped vacuity guard outranks
a finding, because a run that proved nothing cannot also be trusted to have
found everything.

Everything here is pure: a report in, a string or a number out.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from http.client import responses
from types import MappingProxyType

from scripts.dast.references import EvidenceWitness, ReferenceLocation, WitnessCondition
from scripts.dast.verdict import Cell, CellResult, GuardFailure, ReferenceCellResult, Verdict

EXIT_CLEAN = 0
EXIT_AUTHZ_FINDING = 1
EXIT_UNCOVERED = 2
EXIT_HARNESS_ERROR = 3

# Each clause is one printed line, indented to sit under the summary block. The
# note has to describe the check that actually ran: a green from a matrix this
# narrow must not be read as "no BOLA anywhere", and every limit named here is
# one somebody would otherwise have to rediscover from the source.
_SCOPE_CLAUSES = (
    "scope: object references named in the path, in a JSON request body, and in",
    "query parameters; an id reaching the application any other way -- a header,",
    "a nested body object, a plural *_ids collection -- is outside this matrix.",
    "A body- or query-carried id is covered only where the response distinguishes",
    "a foreign reference from an absent one: a route that renders the reference",
    "through an owner-scoped lookup, or reads it back through a creator-scoped",
    "surface, renders an id it persisted exactly as it renders one it never",
    "accepted, and this matrix cannot tell those apart.",
)
SCOPE_NOTE = "\n  ".join(_SCOPE_CLAUSES)

# Spelled from the verdict itself rather than repeated inline, so the headline
# and the grading vocabulary cannot drift apart.
PASS_HEADLINE = (
    f"{Verdict.PASS.name}  every probed route denied the intruder and answered its own owner"
)

# The summary labels are padded to one column so the four counts line up and the
# block diffs cleanly between runs.
_SUMMARY_LABEL_WIDTH = 37
# Wide enough for DELETE, which keeps the path column aligned across verbs.
_METHOD_WIDTH = 6
# The curl repro wraps onto a continuation line indented under the command.
_REPRO_INDENT = " " * 20

_ACTOR_BY_CELL = {
    Cell.CROSS_USER: "user B token",
    Cell.UNAUTH: "no token",
    Cell.FORGED_JWT: "forged token",
    Cell.POSITIVE_CONTROL: "user A token",
    # Both reference cells are sent by the same caller; only the id differs.
    Cell.CROSS_REFERENCE: "user B token",
    Cell.REFERENCE_CONTROL: "user B token",
}

_EXPECTATION_BY_CELL = {
    Cell.CROSS_USER: "403/404",
    Cell.UNAUTH: "401",
    Cell.FORGED_JWT: "401",
    Cell.POSITIVE_CONTROL: "2xx",
    Cell.CROSS_REFERENCE: "403/404, or a 2xx with no trace of the id",
    Cell.REFERENCE_CONTROL: "2xx carrying the caller's own id",
}

# Whose object the injected id named, for the line a reader triages from.
_REFERENCE_OWNER_BY_CELL = {
    Cell.CROSS_REFERENCE: "user A",
    Cell.REFERENCE_CONTROL: "its own",
}

_CARRIER_BY_LOCATION = {
    ReferenceLocation.BODY: "body",
    ReferenceLocation.QUERY: "query",
}

# Shell variables rather than real tokens: a report is pasted into issues.
_TOKEN_VARIABLE_BY_CELL: dict[Cell, str | None] = {
    Cell.CROSS_USER: "$B_TOKEN",
    Cell.UNAUTH: None,
    Cell.FORGED_JWT: "$FORGED_TOKEN",
    Cell.POSITIVE_CONTROL: "$A_TOKEN",
    Cell.CROSS_REFERENCE: "$B_TOKEN",
    Cell.REFERENCE_CONTROL: "$B_TOKEN",
}


@dataclass(frozen=True)
class MatrixReport:
    """Everything one run produced, and the two things a caller wants from it.

    Attributes:
        base_url: The instance that was probed, used to build repro commands.
        discovered: How many object-scoped routes the document declared.
        seeded: How many routes had their objects created successfully.
        uncovered: Routes the harness could neither probe nor excuse, rendered
            as ``"METHOD /path"``.
        allowlisted: How many routes carry a written opt-out.
        results: Every graded cell, in the order it ran.
        guard_failures: Every vacuity guard that tripped.
        elapsed_seconds: Wall-clock time the matrix took.
        reference_results: Every graded body- or query-reference cell, in the
            order it ran. Empty for a run given no reference registry.
    """

    base_url: str
    discovered: int
    seeded: int
    uncovered: tuple[str, ...]
    allowlisted: int
    results: tuple[CellResult, ...]
    guard_failures: tuple[GuardFailure, ...]
    elapsed_seconds: float
    reference_results: tuple[ReferenceCellResult, ...] = ()

    @property
    def findings(self) -> tuple[CellResult, ...]:
        """Return the cells that did not pass; passing cells are counted, not printed."""
        return tuple(result for result in self.results if result.verdict is not Verdict.PASS)

    @property
    def reference_findings(self) -> tuple[ReferenceCellResult, ...]:
        """Return the reference cells that did not pass, by the same rule."""
        return tuple(
            result for result in self.reference_results if result.verdict is not Verdict.PASS
        )

    @property
    def references_probed(self) -> int:
        """Return how many distinct ``(route, field)`` references produced cells."""
        return len(
            {
                (result.route.method, result.route.path, result.reference.field)
                for result in self.reference_results
            },
        )

    @property
    def exit_code(self) -> int:
        """Return the process exit code, most-untrustworthy outcome first.

        A tripped guard outranks a finding because a run that could not prove
        anything must be louder than a run that proved everything was fine, and
        a proven leak outranks a coverage gap because it is the more urgent of
        the two. Both are still printed.
        """
        if self.guard_failures:
            return EXIT_HARNESS_ERROR
        if self.findings or self.reference_findings:
            return EXIT_AUTHZ_FINDING
        if self.uncovered:
            return EXIT_UNCOVERED
        return EXIT_CLEAN


def _status_text(status: int) -> str:
    """Render a status as its number and reason phrase, e.g. ``204 No Content``."""
    return f"{status} {responses.get(status, '')}".rstrip()


def _curl_flags(result: CellResult | ReferenceCellResult) -> str:
    """Render the curl command up to but not including the URL."""
    parts = ["curl"]
    if result.route.method != "GET":
        parts.extend(("-X", result.route.method))
    token = _TOKEN_VARIABLE_BY_CELL[result.cell]
    if token is not None:
        parts.extend(("-H", f'"Authorization: Bearer {token}"'))
    return " ".join(parts)


def render_curl(result: CellResult, *, base_url: str) -> str:
    """Render a finding as a single pasteable curl command.

    Args:
        result: The cell to reproduce.
        base_url: The instance that was probed.

    Returns:
        One command line. The wrapped form printed in the report is this same
        command split across two lines, so the two can never disagree.
    """
    return f"{_curl_flags(result)} {base_url}{result.resolved_path}"


def _summary_line(label: str, value: str) -> str:
    """Render one aligned ``label : value`` line of the summary block."""
    return f"  {label:<{_SUMMARY_LABEL_WIDTH}}: {value}\n"


def _summary_lines(report: MatrixReport) -> list[str]:
    """Render the four counts that quantify what the run actually probed."""
    return [
        _summary_line("routes discovered from /openapi.json", f"{report.discovered} object-scoped"),
        _summary_line("seeded as user A", str(report.seeded)),
        _summary_line("UNCOVERED (no seed strategy)", str(len(report.uncovered))),
        _summary_line("allow-listed", str(report.allowlisted)),
        _summary_line("body/query references probed", str(report.references_probed)),
    ]


def _finding_block(result: CellResult, base_url: str) -> list[str]:
    """Render one failing cell as its four-line, self-contained block."""
    ids = ", ".join(f"{name}={value}" for name, value in result.object_ids)
    return [
        f"  FAIL  {result.route.method:<{_METHOD_WIDTH}} {result.route.path}\n",
        (
            f"        {_ACTOR_BY_CELL[result.cell]} + user A {ids}  ->  "
            f"{_status_text(result.status)}   (expected {_EXPECTATION_BY_CELL[result.cell]})\n"
        ),
        f"        repro: {_curl_flags(result)} \\\n",
        f"{_REPRO_INDENT}{base_url}{result.resolved_path}\n",
        "\n",
    ]


def _finding_lines(findings: Sequence[CellResult], base_url: str) -> list[str]:
    """Render every failing cell."""
    return [line for result in findings for line in _finding_block(result, base_url)]


def _reference_repro(result: ReferenceCellResult, base_url: str) -> list[str]:
    """Render the two-line curl repro for a reference finding.

    A query reference reproduces as the URL it was sent to. A body reference
    needs the payload named as well: the ellipsis stands for whatever else the
    route requires, which the probe sent and this report does not carry.
    """
    injected = f"{result.reference.field}={result.object_id}"
    if result.reference.location is ReferenceLocation.QUERY:
        return [
            f"        repro: {_curl_flags(result)} \\\n",
            f"{_REPRO_INDENT}{base_url}{result.resolved_path}?{injected}\n",
        ]
    payload = f"-d '{{\"{result.reference.field}\": {result.object_id}, ...}}'"
    return [
        f"        repro: {_curl_flags(result)} {payload} \\\n",
        f"{_REPRO_INDENT}{base_url}{result.resolved_path}\n",
    ]


# How each witness condition reads in a finding block, so the sentence names the
# predicate that was evaluated rather than merely asserting a conclusion.
_CONDITION_PHRASES: Mapping[WitnessCondition, str] = MappingProxyType(
    {
        WitnessCondition.IS_FALSE: "false",
        WitnessCondition.AT_LEAST_ONE: "at least one",
    },
)


def _id_scan_phrase(*, reached: bool) -> str:
    """Say what a scan of the evidence for the injected id found."""
    if reached:
        return "the referenced object came back in the response"
    return "the referenced object never appeared in the response"


def _witness_phrase(witness: EvidenceWitness, *, reached: bool) -> str:
    """Say what the declared witness read, naming the field and the condition.

    An operator triaging one of these has to be able to check the claim against
    the route by eye, so the whole predicate is spelled out rather than
    summarised as "the evidence".
    """
    predicate = f"{'.'.join(witness.pointer)} {_CONDITION_PHRASES[witness.condition]}"
    if reached:
        return f"the response came back with {predicate}, which only a landed write produces"
    return f"the response came back without {predicate}, so the write never landed"


def _evidence_phrase(result: ReferenceCellResult) -> str:
    """Say in one clause what the evidence showed, which the status cannot.

    Unreadable evidence gets its own sentence rather than borrowing the absence
    one. "The object never appeared" and "nobody could look" are different
    findings with different fixes, and a block that conflated them would send
    the reader hunting for an authorization bug in a route whose read surface
    was simply broken.
    """
    if result.evidence_unavailable:
        return "there was no readable evidence to grade, so this cell proves nothing"
    witness = result.reference.witness
    if witness is None:
        return _id_scan_phrase(reached=result.object_was_reached)
    return _witness_phrase(witness, reached=result.object_was_reached)


def _reference_finding_block(result: ReferenceCellResult, base_url: str) -> list[str]:
    """Render one failing reference cell as its self-contained block.

    The field and its carrier lead the block because they are what a path
    finding never needs and a reference finding cannot do without: "IDOR on
    POST /journal/" does not say what to put in the body.
    """
    carrier = _CARRIER_BY_LOCATION[result.reference.location]
    injected = f"{result.reference.field}={result.object_id}"
    return [
        (
            f"  FAIL  {result.route.method:<{_METHOD_WIDTH}} {result.route.path}"
            f"  [{carrier} {result.reference.field}]\n"
        ),
        (
            f"        {_ACTOR_BY_CELL[result.cell]} + "
            f"{_REFERENCE_OWNER_BY_CELL[result.cell]} {injected}  ->  "
            f"{_status_text(result.status)}   "
            f"(expected {_EXPECTATION_BY_CELL[result.cell]})\n"
        ),
        f"        evidence: {_evidence_phrase(result)}\n",
        *_reference_repro(result, base_url),
        "\n",
    ]


def _reference_finding_lines(
    findings: Sequence[ReferenceCellResult],
    base_url: str,
) -> list[str]:
    """Render every failing reference cell."""
    return [line for result in findings for line in _reference_finding_block(result, base_url)]


def _uncovered_lines(uncovered: Sequence[str]) -> list[str]:
    """Render the routes with neither a seed strategy nor an allow-list entry."""
    lines = []
    for item in uncovered:
        method, _, path = item.partition(" ")
        lines.append(f"  UNCOVERED  {method:<{_METHOD_WIDTH}} {path}\n")
    return lines


def _guard_lines(guard_failures: Sequence[GuardFailure]) -> list[str]:
    """Render every tripped vacuity guard, each naming itself."""
    return [f"  HARNESS ERROR  {failure.guard}: {failure.detail}\n" for failure in guard_failures]


def render_report(report: MatrixReport) -> str:
    """Render a finished run as the text the gate prints.

    Args:
        report: The run to render.

    Returns:
        A newline-terminated block: the coverage summary and scope note first,
        so even a failing run states what it managed to cover, then the tripped
        guards, the findings, and the uncovered routes. A run with none of those
        ends on a headline that says what was proven rather than staying silent.
    """
    lines = [
        f"  authorization matrix: {report.base_url} ({report.elapsed_seconds:.1f}s)\n",
        *_summary_lines(report),
        f"  {SCOPE_NOTE}\n",
        "\n",
        *_guard_lines(report.guard_failures),
        *_finding_lines(report.findings, report.base_url),
        *_reference_finding_lines(report.reference_findings, report.base_url),
        *_uncovered_lines(report.uncovered),
    ]
    if report.exit_code == EXIT_CLEAN:
        lines.append(f"  {PASS_HEADLINE}\n")
    return "".join(lines)
