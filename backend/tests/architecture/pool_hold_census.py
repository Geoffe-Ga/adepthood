"""The written record of every place a route dials out, and what is known about each.

A census that lists only failures cannot tell a reader whether an unlisted site
was examined or missed, so this file carries both halves. :data:`HELD` names
every route reaching an outbound call with its connection still checked out.
:data:`CLEAR` names the routes that were examined and found to release first,
each with the reason -- and those are *asserted*, not merely stated, so a
regression at one of them is a red build rather than a stale paragraph.

**How this stays a census and not a suppression file.** The gate beside it
asserts set equality, not emptiness. It is green at HEAD, red the moment a new
site appears, and red again when a site is fixed and its row is left standing.
That last direction is the one that matters: a file that only ever grows is a
suppression list, and a file that must shrink when the code improves is a record.

**The escape hatch, and what stops it degrading.** A static analysis will
eventually be wrong about a site that is genuinely safe, and a gate with no way
to say so gets deleted. So a row may be marked :attr:`Verdict.MISMODELLED` --
but only by naming a runtime test that watches the same dial and *passes*.
Whether it passes is not a matter of opinion: the runtime census marks its
defective rows expected-failure, so a row claiming the analyser is wrong must
name a test carrying no such marker, and the gate checks that by reading the
file. Prose alone cannot buy an exemption; a green assertion at the same seam
can. Today the list is empty, which is the state to keep it in.

**Why the evidence column exists.** The runtime observer and this analyser are
blind in opposite places, and the field that says which rows have been seen by
both is the field a reader most needs. Two rows below carry no runtime evidence
at all, and they are not an oversight -- they are the two the running suite
cannot currently reach, which is the whole argument for reading the source
instead of watching it.
"""

from __future__ import annotations

import ast
from collections.abc import Iterator
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

from tests.architecture.pool_hold import HeldDial

# The runtime half of this census: one test per row, driving the real route.
# Named here so a claim about what the suite proves can be checked against the
# suite rather than believed.
RUNTIME_CENSUS = (
    Path(__file__).resolve().parents[1]
    / "security"
    / "test_connection_never_held_across_an_outbound_call.py"
)


class Verdict(StrEnum):
    """What is known about a route that dials with its connection held."""

    KNOWN = "known"
    """A real defect, not yet fixed. Removing it means fixing the site."""

    ALLOWED = "allowed"
    """Deliberate: the hold buys an atomicity the row must name, at a cost it must also name."""

    MISMODELLED = "mismodelled"
    """The analyser is wrong here, and a passing runtime test at the same dial says so."""


@dataclass(frozen=True)
class CensusRow:
    """One route reaching an outbound call with its connection still held.

    Attributes:
        route: The HTTP route, as the application serves it.
        holder: Qualified name of the function containing the outbound call.
        dial: What is dialled. No line numbers anywhere: a census keyed on them
            goes red on a blank line and teaches its readers to edit it
            unread.
        verdict: What is known about the row.
        reason: Why the connection is held here, in prose, at the site.
        costs: What the hold costs. Required of an ``ALLOWED`` row, because an
            exemption that names only its benefit is an argument with one side.
        observed_by: A test in :data:`RUNTIME_CENSUS` that watches this dial, or
            the empty string where the suite does not reach it. Required of a
            ``MISMODELLED`` row, and there it must name a test that passes.
    """

    route: str
    holder: str
    dial: str
    verdict: Verdict
    reason: str
    costs: str = ""
    observed_by: str = ""

    @property
    def key(self) -> HeldDial:
        """Return the finding this row claims to account for."""
        return HeldDial(self.route, self.holder, self.dial)


@dataclass(frozen=True)
class ClearRoute:
    """A route examined and found to release its connection before it dials.

    Attributes:
        route: The HTTP route, as the application serves it.
        handler: Qualified name of the function serving it.
        reason: What makes it clear -- a release in front of the dial, an
            ordering that dials before any query, or no outbound call at all.
    """

    route: str
    handler: str
    reason: str


# --- Held: routes that dial while holding a connection ----------------------

HELD: tuple[CensusRow, ...] = (
    CensusRow(
        route="GET /invitations",
        holder="services.creek_vault_wheel.fetch_vault_wheel",
        dial="handshake",
        verdict=Verdict.KNOWN,
        reason=(
            "_gather_aggregates evaluates its four arguments in order: three database "
            "gathers and then the vault. The transaction is open at the dial whichever "
            "branch the vault dependency took, because those three gathers re-open it "
            "after the dependency released. On a polled list endpoint, so the hold "
            "recurs on a timer rather than on a user action."
        ),
        observed_by="test_the_invitation_corpus_themes_are_dialled_off_the_pool",
    ),
    CensusRow(
        route="GET /invitations",
        holder="services.creek_vault_wheel._read_balance",
        dial="wheel",
        verdict=Verdict.KNOWN,
        reason=(
            "The second half of the same vault round trip: the capability probe is "
            "followed by the read it gates, both under the transaction the three "
            "aggregate gathers left open."
        ),
        observed_by="test_the_invitation_corpus_themes_are_dialled_off_the_pool",
    ),
    CensusRow(
        route="POST /auth/oauth/google",
        holder="integrations.gumroad._post_once",
        dial="client.post",
        verdict=Verdict.KNOWN,
        reason=(
            "Resolving an existing account issues an identity SELECT and an email "
            "SELECT. On the create path both return nothing, and the handler then "
            "posts to a third-party licensing host under the transaction those two "
            "lookups opened. The JWKS fetch earlier in the same handler is not this "
            "row: it is the handler's first awaited statement, before any query, and "
            "is safe by position rather than by release."
        ),
        observed_by="test_the_oauth_license_check_is_dialled_off_the_pool",
    ),
    CensusRow(
        route="POST /auth/oauth/apple",
        holder="integrations.gumroad._post_once",
        dial="client.post",
        verdict=Verdict.KNOWN,
        reason=(
            "The same defect down the sibling provider, reached through the same "
            "account-resolution helper. It is a separate row because it is a separate "
            "route, and because a fix applied to one provider's handler and not the "
            "other would leave this one standing."
        ),
        observed_by="",
    ),
    CensusRow(
        route="POST /auth/password-reset/confirm",
        holder="routers.auth._send_change_notification_safely",
        dial="send",
        verdict=Verdict.KNOWN,
        reason=(
            "The reset is committed and then a session.refresh on the very next line "
            "emits a SELECT, which autobegins a fresh transaction; the out-of-band "
            "notification email is sent under it. The near-identical sibling route "
            "POST /auth/password-reset/request is clear, and the whole difference "
            "between them is that one line."
        ),
        observed_by="test_the_password_change_notification_is_sent_off_the_pool",
    ),
    CensusRow(
        route="POST /journal/marginalia/{marginalia_id}/essay",
        holder="domain.resonance.generate_essay",
        dial="complete",
        verdict=Verdict.KNOWN,
        reason=(
            "Two ownership SELECTs precede the essay call and the commit comes only "
            "after it, so a full long-form language-model completion is paid for in "
            "one pooled connection -- the longest single hold the survey behind this "
            "census timed."
        ),
        observed_by="test_the_essay_llm_is_dialled_off_the_pool",
    ),
    CensusRow(
        route="POST /journal/{entry_id}/resonance",
        holder="services.creek_vault_reflect.select_reflection_llm",
        dial="handshake",
        verdict=Verdict.KNOWN,
        reason=(
            "A wallet deduction is staged without committing, grounding is gathered, "
            "and then the vault is probed for capability -- so this dial runs on a "
            "dirty write transaction. The handler's atomicity argument covers the "
            "reflection pass below and does not reach here: a capability probe's "
            "result is not something a rollback can undo."
        ),
        observed_by="test_the_resonance_vault_handshake_is_dialled_off_the_pool",
    ),
    CensusRow(
        route="POST /journal/{entry_id}/resonance",
        holder="domain.resonance._one_pass",
        dial="complete",
        verdict=Verdict.KNOWN,
        reason=(
            "The reflection pass itself, on the same dirty write transaction. The "
            "handler documents this hold as intentional -- the pass, the persistence "
            "and the charge commit together, so a provider error rolls the deduction "
            "back and a failed pass never charges. That argument is real, which is why "
            "this row is the census's hardest: it is a correctness trade, not an "
            "oversight, and settling it means either an exemption naming its cost or "
            "the design change that stages the deduction in its own transaction and "
            "compensates on failure."
        ),
        observed_by="test_the_resonance_reflection_pass_is_dialled_off_the_pool",
    ),
    CensusRow(
        route="POST /journal/{entry_id}/resonance",
        holder="domain.detection.detect_completions",
        dial="complete",
        verdict=Verdict.KNOWN,
        reason=(
            "A third language-model call on the same route, after the reflection pass "
            "and still ahead of the commit: persisting the resonance runs completion "
            "detection, which gathers candidates with a SELECT and then completes "
            "against the provider. No runtime test reaches it and no hand-written "
            "survey found it -- it is here because the analyser reads the call chain "
            "rather than the sites somebody thought to look at, which is the argument "
            "for having it."
        ),
        observed_by="",
    ),
    CensusRow(
        route="POST /journal/transcribe-page",
        holder="routers.transcription._run_transcription",
        dial="services.botmason.generate_response",
        verdict=Verdict.ALLOWED,
        reason=(
            "The wallet deduction is staged uncommitted and every one of the three "
            "error arms rolls it back before mapping the failure to a status, so a "
            "provider error never charges the writer for a page they did not get. "
            "That is genuine atomicity bought deliberately, not a site somebody "
            "forgot."
        ),
        costs=(
            "A pooled connection held for a vision-model round trip -- the "
            "longest-latency provider shape in the repository -- on every page a "
            "writer transcribes. Fifteen concurrent transcriptions exhaust the "
            "default pool and the next request to any database-backed endpoint blocks "
            "at checkout. The alternative is to commit the deduction in its own "
            "transaction and compensate on failure, which costs a refund path in "
            "exchange for the connection."
        ),
        observed_by="test_the_page_transcription_is_dialled_off_the_pool",
    ),
)


# --- Clear: routes examined and found to release before dialling ------------

CLEAR: tuple[ClearRoute, ...] = (
    ClearRoute(
        route="POST /journal/",
        handler="routers.journal.create_journal_entry",
        reason=(
            "The vault write releases first -- a commit sits on the statement before "
            "store_and_classify -- and the corpus fragment path releases inside the "
            "ingest chokepoint rather than at this router."
        ),
    ),
    ClearRoute(
        route="PATCH /journal/{entry_id}",
        handler="routers.journal.update_journal_entry",
        reason="Reaches the same two release points as the create path, and no others.",
    ),
    ClearRoute(
        route="PUT /vault/connection",
        handler="routers.vault_config.put_vault_connection",
        reason=(
            "The host verdict is asked through the seam that commits before it "
            "resolves, so the name lookup runs off the pool."
        ),
    ),
    ClearRoute(
        route="PUT /corpus/consent/{source}",
        handler="routers.corpus.put_corpus_consent",
        reason=(
            "The backfill reaches the ingest chokepoint, which commits one statement "
            "in front of the classifier -- landing the staged consent event early, "
            "which is the same release. The property belongs to the chokepoint, not "
            "to this router, which is why a fifth caller cannot forget it."
        ),
    ),
    ClearRoute(
        route="POST /corpus/import",
        handler="routers.corpus.import_corpus_document",
        reason=(
            "Clear down both vault branches since the resolver was made to release on "
            "each of its two exits. Before that it was clear only for a caller with a "
            "connection row of their own, and defective for one served the "
            "deployment-wide vault -- a branch no test drives."
        ),
    ),
    ClearRoute(
        route="GET /stages/wheel",
        handler="routers.stages.get_wheel_balance",
        reason=(
            "Clear for the same reason and by the same one-line change as the corpus "
            "import above; the two rows closed together because they shared a "
            "resolver, not a handler."
        ),
    ),
    ClearRoute(
        route="POST /auth/signup",
        handler="routers.auth.signup",
        reason=(
            "Safe by ordering rather than by release: the licence check is the "
            "handler's first awaited statement, deliberately ahead of the "
            "duplicate-email lookup so a caller cannot enumerate registered "
            "addresses. Stable, but stable for a reason that has nothing to do with "
            "the pool."
        ),
    ),
    ClearRoute(
        route="POST /auth/password-reset/request",
        handler="routers.auth.request_password_reset",
        reason=(
            "Mints and persists the token, commits, and sends -- with no refresh after "
            "the commit and no mapped attribute read at the send. The confirm route "
            "next door does the same thing with one extra line and is defective, which "
            "is how narrow the difference is."
        ),
    ),
    ClearRoute(
        route="DELETE /journal/{entry_id}",
        handler="routers.journal.delete_journal_entry",
        reason="Database only: the withdrawal deletes fragments and logs. Nothing dials.",
    ),
)


# Modules with no production caller. Carried here rather than as an exemption:
# an exemption implies a site that runs, and this one does not. Its vault branch
# is inert by its own docstring and it takes no session, so it could not hold a
# connection even if something called it. It should be deleted rather than
# maintained, which is a later change than this one.
DEAD_MODULES: tuple[str, ...] = ("services.frequency_source",)


def expected_findings() -> frozenset[HeldDial]:
    """Return the findings this census accounts for."""
    return frozenset(row.key for row in HELD)


# Markers under which a test cannot stand as proof that a site releases.
# ``xfail`` asserts the opposite outcome. ``skip`` and ``skipif`` assert nothing
# at all, which is worse: an expected failure at least runs.
_MARKERS_THAT_PROVE_NOTHING = frozenset({"xfail", "skip", "skipif"})


def runtime_tests(path: Path = RUNTIME_CENSUS) -> dict[str, bool]:
    """Map each test in the runtime census to whether its result can be relied on.

    ``True`` means the test cannot stand as evidence -- it is expected to fail or
    it does not run. Read from the file rather than imported, so the question
    costs no fixtures and can still be answered when the module it describes
    cannot be collected.
    """
    tree = ast.parse(path.read_text(encoding="utf-8"))
    whole_module = _module_scope_markers(tree)
    return {
        node.name: whole_module or any(_proves_nothing(d) for d in node.decorator_list)
        for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef)
        and node.name.startswith("test_")
    }


def _module_scope_markers(tree: ast.Module) -> bool:
    """Report whether ``pytestmark`` disarms every test in the module.

    pytest applies a module-level ``pytestmark`` to each test in the file, so a
    validator that reads only a function's own decorators can be disarmed
    wholesale by one line at the top -- and every exemption in this census
    becomes purchasable with it.
    """
    for node in tree.body:
        for name, value in _assigned(node):
            if name != "pytestmark":
                continue
            marks = value.elts if isinstance(value, ast.List | ast.Tuple) else [value]
            if any(_proves_nothing(mark) for mark in marks):
                return True
    return False


def _assigned(node: ast.stmt) -> Iterator[tuple[str, ast.expr]]:
    """Yield ``(name, value)`` for each module-level assignment to a plain name."""
    if isinstance(node, ast.Assign):
        for target in node.targets:
            if isinstance(target, ast.Name) and node.value is not None:
                yield target.id, node.value
    elif (
        isinstance(node, ast.AnnAssign)
        and isinstance(node.target, ast.Name)
        and node.value is not None
    ):
        yield node.target.id, node.value


def _proves_nothing(marker: ast.expr) -> bool:
    """Report whether a marker means the test's result cannot be leaned on."""
    target = marker.func if isinstance(marker, ast.Call) else marker
    return isinstance(target, ast.Attribute) and target.attr in _MARKERS_THAT_PROVE_NOTHING


def evidence_problems(
    rows: tuple[CensusRow, ...] = HELD, known_tests: dict[str, bool] | None = None
) -> list[str]:
    """Return one message per row whose stated evidence does not hold up.

    Four rules, and the last is the one that keeps the escape hatch honest.
    Every row must give a reason; an ``ALLOWED`` row must name what its hold
    costs as well as what it buys; a named runtime test must exist; and a
    ``MISMODELLED`` row -- the row that says the analyser is wrong -- must name a
    test carrying no expected-failure marker, because a claim that a site
    releases is only worth anything if something green asserts it.
    """
    tests = runtime_tests() if known_tests is None else known_tests
    problems: list[str] = []
    for row in rows:
        others = {other.observed_by for other in rows if other is not row}
        problems.extend(_row_problems(row, tests, others))
    return problems


def _row_problems(row: CensusRow, tests: dict[str, bool], others: set[str]) -> list[str]:
    """Return the evidence rules one row breaks."""
    where = f"{row.route} -> {row.holder} -> {row.dial}"
    problems = []
    if not row.reason.strip():
        problems.append(f"{where}: no reason given")
    if row.verdict is Verdict.ALLOWED and not row.costs.strip():
        problems.append(f"{where}: allowed without naming what the hold costs")
    if row.observed_by and row.observed_by not in tests:
        problems.append(f"{where}: names runtime test {row.observed_by!r}, which does not exist")
    if row.verdict is Verdict.MISMODELLED:
        problems.extend(_mismodelled_problems(row, tests, where, others))
    return problems


def _mismodelled_problems(
    row: CensusRow, tests: dict[str, bool], where: str, others: set[str]
) -> list[str]:
    """Return the reasons a claim that the analyser is wrong is not yet backed.

    The last rule is the weakest of the three and worth naming as such: it stops
    one green test being copied across rows, which is the cheap way to make the
    evidence column meaningless. It does not prove the named test is about this
    row's dial. Nothing cheap does -- the analysis keys on the innermost call and
    the observer on a registry leaf, and the two do not line up mechanically --
    so that correspondence stays a thing a reviewer checks, and it is named in
    the limits section rather than implied to be covered.
    """
    if not row.observed_by:
        return [f"{where}: called mismodelled with no runtime test proving the release"]
    if tests.get(row.observed_by, False):
        return [
            (
                f"{where}: called mismodelled, but {row.observed_by!r} is expected to fail or "
                "does not run, so it proves the opposite or nothing"
            )
        ]
    if row.observed_by in others:
        return [
            (
                f"{where}: called mismodelled on {row.observed_by!r}, which is "
                "already the evidence for another row"
            )
        ]
    return []
