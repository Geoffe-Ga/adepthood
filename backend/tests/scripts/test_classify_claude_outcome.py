"""Tripwires for the scheduled Claude run's outcome classifier.

The nightly grooming workflow reports failure on most of its recent scheduled
runs, in two ways that are indistinguishable from the run list and that call for
opposite responses.

The first is a false red. The grooming ran to completion and wrote its summary,
and then the action exited non-zero because the conversation used more turns
than its cap allowed. Captured runs used 41, 44 and 45 turns against a cap of
40. The work landed; the job says failure.

The second is a real red. One turn, nothing done, ``is_error`` true, HTTP 429,
and a result reading "You've hit your weekly limit". Retrying that before the
reset spends wall clock and achieves nothing.

THE FACT THAT MAKES THIS HARD: hitting the turn cap has TWO transcript shapes,
they mean opposite things, and only one of them is visible in the file.

* The ACTION's post-hoc check. The conversation ends normally and the action
  then compares the turn count against ``--max-turns`` and exits non-zero. Its
  result message carries ``subtype: "success"`` and ``is_error: false`` -- the
  same shape a perfectly clean run produces -- so nothing in the transcript
  separates it from a clean run, and the only thing that does is that the
  action's *step* failed. The work landed and its summary was written. Benign.
* The SDK's OWN cap enforcement, which action 20260823.283.1 also emits. The
  conversation is CUT OFF mid-turn: ``is_error: true``, ``subtype:
  "error_max_turns"``, ``terminal_reason: "max_turns"``, ``stop_reason:
  "tool_use"``, ``errors: ["Reached maximum number of turns (N)"]`` -- and no
  ``result`` key at all, so there are no last words to fall back on. The work
  was truncated and its summary was never written. NOT benign.

The two need opposite verdicts and opposite operator advice: nothing to re-run
against raise the cap and re-run. Enforcement is inconsistent within one action
version -- a captured run reached 47 turns against a cap of 40 and passed -- so
both shapes stay covered here rather than one replacing the other.

Because the first shape is invisible in the file, the classifier takes three
inputs rather than one, and the cases below exercise all three. Two of them
below feed the identical transcript in with opposite step outcomes and demand
opposite tokens; that pair is the specification.

WHY NO VERDICT IS EVER KEYED ON TIME OR MONEY: a usage-limit failure and an
expired-credential failure have the same timing shape -- one turn, well under a
minute, zero dollars -- and need opposite operator advice ("wait for the reset,
retrying is wasted" versus "rotate the secret"). A classifier reading
``duration_ms`` or ``total_cost_usd`` would tell the operator the wrong thing
half the time. Everything here classifies on structural fields first
(``is_error``, ``api_error_status``, ``subtype``, ``num_turns``) and consults the
result string only as a fallback for the cause and as material for the headline.

The script keeps the same contract as ``scripts/ralph/playbook-wip-gate.sh``:
exactly ONE token on stdout, exit 0. A non-zero exit is a usage or tooling
fault, never a verdict, so a broken invocation can never be mistaken for an
answer about the run.

Fixtures under ``tests/fixtures/claude_runs/`` named ``synthesized-*`` were
hand-built to the documented shape; the rest were extracted verbatim from real
Actions runs. No captured auth failure survives inside the 90-day log window,
which is why that one is a reconstruction and is labelled in its filename as
such. ``turn-cap-truncated-41-turns.json`` is the SDK-enforcement shape, lifted
byte-for-byte from the result message of run 33304651747 -- a reconstruction
would have been guesswork about which fields the SDK emits, and the whole defect
it pins is that the classifier reads fields that shape does not carry.

Every case runs the real script in a subprocess. The unit under test is a shell
script and has no in-process seam.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
_CLASSIFY = _REPO_ROOT / "scripts" / "ci" / "classify_claude_outcome.sh"
_RUNS = Path(__file__).resolve().parents[1] / "fixtures" / "claude_runs"

COMPLETED = "completed"
TURN_CAP_OVERRUN = "turn-cap-overrun"
TURN_CAP_TRUNCATED = "turn-cap-truncated"
USAGE_LIMIT = "usage-limit"
AUTH_FAILURE = "auth-failure"
AGENT_ERROR = "agent-error"
NO_RESULT = "no-result"
SKIPPED = "skipped"

# Every verdict the classifier may reach. A usage fault must produce none of
# these on stdout, which is what keeps "the tool broke" separable from "the run
# broke".
TOKENS = (
    COMPLETED,
    TURN_CAP_OVERRUN,
    TURN_CAP_TRUNCATED,
    USAGE_LIMIT,
    AUTH_FAILURE,
    AGENT_ERROR,
    NO_RESULT,
    SKIPPED,
)

# The same exit code the other repo-owned gate scripts use for a usage fault.
EXIT_USAGE = 2

# The cap every fixture here was captured against. Deliberately NOT read from
# the workflow: these files are historical records, and raising the live cap
# must not silently re-interpret a run that happened under the old one.
LIVE_MAX_TURNS = 40

# A headline is one line an operator reads in the run list. This ceiling exists
# to kill the cheapest wrong implementation: pasting the whole multi-kilobyte
# result message in and calling it a headline.
HEADLINE_CHARACTER_CEILING = 400

# Not a filename. The skip family is defined by the transcript being ABSENT,
# so the table names the absence rather than pointing at a file that would
# have to exist to say "this one does not exist".
MISSING_TRANSCRIPT = None

TURN_CAP_44 = "turn-cap-overrun-44-turns.json"
TURN_CAP_41 = "turn-cap-overrun-41-turns.json"
TURN_CAP_TRUNCATED_RUN = "turn-cap-truncated-41-turns.json"
USAGE_LIMIT_RUN = "usage-limit-weekly.json"
AUTH_FAILURE_RUN = "synthesized-auth-failure-401.json"
NO_RESULT_RUN = "synthesized-no-result-message.json"


# (fixture, step outcome, cap, expected token). Between them these rows reach
# every token; `test_every_token_is_reachable_from_a_fixture` holds that true as
# rows are edited.
@dataclass(frozen=True)
class Scenario:
    """One (input, expected verdict) row of the table below.

    A record rather than a tuple because the inputs outgrew what a positional
    signature can carry legibly -- five loose parameters per test read as noise
    at the call site and say nothing about which is which.
    """

    fixture: str | None
    step_outcome: str
    max_turns: int
    skip_permitted: str
    expected: str

    @property
    def label(self) -> str:
        """A pytest id that says what the row is, not merely that it exists."""
        transcript = "no-transcript" if self.fixture is MISSING_TRANSCRIPT else self.fixture
        skip = "-skippable" if self.skip_permitted == "true" else ""
        return f"{transcript}-{self.step_outcome}-cap{self.max_turns}{skip}"


SCENARIOS = [
    Scenario(TURN_CAP_44, "success", LIVE_MAX_TURNS, "false", COMPLETED),
    Scenario(TURN_CAP_44, "failure", LIVE_MAX_TURNS, "false", TURN_CAP_OVERRUN),
    Scenario(TURN_CAP_41, "failure", LIVE_MAX_TURNS, "false", TURN_CAP_OVERRUN),
    Scenario(TURN_CAP_41, "failure", 60, "false", AGENT_ERROR),
    Scenario(TURN_CAP_TRUNCATED_RUN, "failure", LIVE_MAX_TURNS, "false", TURN_CAP_TRUNCATED),
    Scenario(USAGE_LIMIT_RUN, "failure", LIVE_MAX_TURNS, "false", USAGE_LIMIT),
    Scenario(AUTH_FAILURE_RUN, "failure", LIVE_MAX_TURNS, "false", AUTH_FAILURE),
    Scenario(NO_RESULT_RUN, "failure", LIVE_MAX_TURNS, "false", NO_RESULT),
    Scenario(MISSING_TRANSCRIPT, "success", LIVE_MAX_TURNS, "true", SKIPPED),
]


@dataclass(frozen=True)
class Classification:
    """One run of the classifier: what it said, and everywhere it said it."""

    token: str
    exit_code: int
    stderr: str
    summary: str
    output: str


def _run(tmp_path: Path, *args: str) -> Classification:
    """Run the real script with fresh ``GITHUB_*`` files and capture every channel.

    Each call gets its own pair of files so a test may classify twice without
    reading the previous run's summary back as this one's.
    """
    workspace = Path(tempfile.mkdtemp(dir=tmp_path))
    summary = workspace / "step-summary.md"
    output = workspace / "github-output.txt"
    summary.touch()
    output.touch()
    env = {
        **os.environ,
        "GITHUB_STEP_SUMMARY": str(summary),
        "GITHUB_OUTPUT": str(output),
    }
    completed = subprocess.run(
        [str(_CLASSIFY), *args],
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )
    return Classification(
        token=completed.stdout.strip(),
        exit_code=completed.returncode,
        stderr=completed.stderr,
        summary=summary.read_text(encoding="utf-8"),
        output=output.read_text(encoding="utf-8"),
    )


def _classify(
    tmp_path: Path,
    execution_file: Path,
    *,
    step_outcome: str,
    max_turns: int = LIVE_MAX_TURNS,
    skip_permitted: str = "false",
) -> Classification:
    """Classify one execution file, insisting the script exited 0 as a query must."""
    result = _run(
        tmp_path,
        "--execution-file",
        str(execution_file),
        "--step-outcome",
        step_outcome,
        "--max-turns",
        str(max_turns),
        "--skip-permitted",
        skip_permitted,
    )
    assert result.exit_code == 0, (
        "a verdict is carried by the token, not the exit code; a non-zero exit here "
        f"means the script treated a classifiable run as a usage fault: {result.stderr}"
    )
    return result


def _transcript(tmp_path: Path, fixture: str | None) -> Path:
    """Resolve a scenario's fixture name, or a path that deliberately does not exist."""
    if fixture is MISSING_TRANSCRIPT:
        return tmp_path / "no-transcript-was-written.json"
    return _RUNS / fixture


def _classify_scenario(tmp_path: Path, scenario: Scenario) -> Classification:
    """Run one table row, resolving its transcript and carrying its skip flag."""
    return _classify(
        tmp_path,
        _transcript(tmp_path, scenario.fixture),
        step_outcome=scenario.step_outcome,
        max_turns=scenario.max_turns,
        skip_permitted=scenario.skip_permitted,
    )


def _token(
    tmp_path: Path,
    fixture: str,
    *,
    step_outcome: str = "failure",
    max_turns: int = LIVE_MAX_TURNS,
) -> str:
    """Return the single token the classifier prints for one named fixture."""
    return _classify(
        tmp_path, _RUNS / fixture, step_outcome=step_outcome, max_turns=max_turns
    ).token


def _result_message(fixture: str) -> dict[str, Any]:
    """Return the trailing ``type: result`` message of a captured run file."""
    messages: list[dict[str, Any]] = json.loads((_RUNS / fixture).read_text(encoding="utf-8"))
    return next(message for message in reversed(messages) if message.get("type") == "result")


def _forge(tmp_path: Path, name: str, **overrides: object) -> Path:
    """Write a run file whose result message is the usage-limit one with fields replaced.

    Starting from a captured message rather than a hand-typed dict keeps these
    cases honest about the shape the SDK really emits: only the field under
    test differs from something that actually happened.
    """
    result = {**_result_message(USAGE_LIMIT_RUN), **overrides}
    path = tmp_path / name
    path.write_text(json.dumps([result], indent=2, ensure_ascii=False), encoding="utf-8")
    return path


def _output_value(output: str, key: str) -> str:
    """Return the value written for ``key`` in a captured ``GITHUB_OUTPUT`` file."""
    prefix = f"{key}="
    for line in output.splitlines():
        if line.startswith(prefix):
            return line[len(prefix) :]
    pytest.fail(f"no {key}= line in GITHUB_OUTPUT; got: {output!r}")


# --- The three inputs, and why one of them is not in the file --------------


def test_the_same_transcript_is_completed_or_an_overrun_by_step_outcome(tmp_path: Path) -> None:
    """The whole reason the classifier takes a step outcome at all.

    One file, read twice, must yield two different verdicts. A turn-cap overrun
    writes ``subtype: success`` and ``is_error: false`` exactly as a clean run
    does, so any implementation that reads only the JSON has to answer the same
    thing both times and cannot pass this.
    """
    assert _token(tmp_path, TURN_CAP_44, step_outcome="success") == COMPLETED
    assert _token(tmp_path, TURN_CAP_44, step_outcome="failure") == TURN_CAP_OVERRUN


@pytest.mark.parametrize(("fixture", "turns"), [(TURN_CAP_41, 41), (TURN_CAP_44, 44)])
def test_a_clean_result_at_or_past_the_cap_is_the_false_red(
    tmp_path: Path, fixture: str, turns: int
) -> None:
    """Both captured overruns are the benign mode: the grooming finished, the cap bit."""
    assert turns >= LIVE_MAX_TURNS, "fixture no longer exceeds the cap it was captured against"
    assert _token(tmp_path, fixture, max_turns=LIVE_MAX_TURNS) == TURN_CAP_OVERRUN


def test_a_clean_result_below_the_cap_fails_closed_as_an_agent_error(tmp_path: Path) -> None:
    """The case that stops this whole change from greening genuine failures.

    Step failed, the transcript says clean success, and the conversation stopped
    short of the cap. Something broke *after* a good result -- a later step, an
    upload, the runner. Reading that as a turn-cap overrun would file it under
    "benign, ignore" forever, so the absence of a cap collision must resolve to
    an error rather than to the comfortable answer.
    """
    assert _token(tmp_path, TURN_CAP_41, max_turns=60) == AGENT_ERROR


# --- The SDK's own cap enforcement, which is a different event entirely -----
#
# The action's post-hoc check above says "you used more turns than allowed,
# after finishing". The SDK's says "I stopped you mid-turn". Same cap, opposite
# consequence, and the transcript is the only place that says which happened.


def test_the_sdk_cap_shape_is_not_filed_as_an_unexplained_agent_error(tmp_path: Path) -> None:
    """The captured verdict this whole change exists to replace.

    Run 33304651747 was cut off at turn 41 of a 40-turn cap and reported as
    "the run reported an error with no cause this classifier recognises" -- a
    headline that names no mode, suggests no action, and is indistinguishable
    from a crashed tool call. The cause is knowable and is stated three times
    over in the message; nothing was reading it.
    """
    assert _token(tmp_path, TURN_CAP_TRUNCATED_RUN) == TURN_CAP_TRUNCATED


def test_the_two_cap_shapes_are_given_opposite_verdicts(tmp_path: Path) -> None:
    """Same cap, same turn count, same failed step -- and opposite advice.

    Both fixtures ran 41 turns against a cap of 40. One finished its work and
    was failed afterwards for the count; the other was cut off before it could
    write anything. Collapsing them would either tell an operator to ignore a
    night of lost grooming, or send them hunting for a failure that did not
    happen.
    """
    assert (
        _result_message(TURN_CAP_41)["num_turns"]
        == _result_message(TURN_CAP_TRUNCATED_RUN)["num_turns"]
    ), "the fixtures no longer share a turn count, so this proves nothing"

    assert _token(tmp_path, TURN_CAP_41) != _token(tmp_path, TURN_CAP_TRUNCATED_RUN)


def test_the_truncated_shape_is_an_error_and_so_is_never_completed(tmp_path: Path) -> None:
    """``is_error`` outranks a green step here as everywhere else.

    Cap enforcement is inconsistent inside one action version -- a captured run
    reached 47 turns and the step passed -- so a truncated transcript beside a
    successful step is a real pairing, not a hypothetical, and the transcript is
    the half of it that is telling the truth.
    """
    assert _token(tmp_path, TURN_CAP_TRUNCATED_RUN, step_outcome="success") != COMPLETED


def test_the_truncated_shape_carries_no_result_string_to_fall_back_on() -> None:
    """States the fact that makes the string fallback useless here.

    Every other error fixture ends with the model saying something, and the
    classifier's cause fallback greps that sentence. This message has no
    ``result`` key at all, so a fallback keyed on prose cannot reach any verdict
    but the default one -- which is exactly how this shape became an
    "agent error". The structural fields have to be read.
    """
    message = _result_message(TURN_CAP_TRUNCATED_RUN)

    assert "result" not in message
    assert message["is_error"] is True
    assert message["subtype"] == "error_max_turns"
    assert message["terminal_reason"] == "max_turns"
    assert message["errors"] == ["Reached maximum number of turns (40)"]


def test_the_truncated_headline_says_the_work_was_cut_off_not_that_it_landed(
    tmp_path: Path,
) -> None:
    """The one sentence an operator reads must not invite them to ignore it.

    "Benign" and "nothing to re-run" are the right words for the other cap
    shape and the wrong words for this one; a headline that reuses them turns a
    lost night of grooming into a run nobody looks at again.
    """
    result = _classify(tmp_path, _RUNS / TURN_CAP_TRUNCATED_RUN, step_outcome="failure")
    headline = _output_value(result.output, "headline").lower()

    assert "benign" not in headline
    assert "nothing to re-run" not in headline
    assert "truncated" in headline or "cut off" in headline


# --- Each of the three cap fields, on its own ------------------------------
#
# The captured fixture carries all three, so any ONE of them satisfies it and a
# classifier reading only `subtype` would pass the case above unchanged. The
# whole point of reading three fields is that no single one is contractual, and
# a redundancy nothing exercises is a redundancy that is not there.

# The names the SDK gives the shape, as the classifier spells them. Kept here
# rather than imported because a shell script has no importable surface: if the
# script's constants are edited and these are not, the cases below go red, which
# is the intended alarm.
SDK_CAP_SUBTYPE = "error_max_turns"
SDK_CAP_TERMINAL_REASON = "max_turns"
SDK_CAP_SENTENCE = "Reached maximum number of turns (40)"

# A status the classifier has no named meaning for. Real: an upstream 5xx can
# accompany any transcript, including a truncated one.
UNRECOGNISED_STATUS = 500

_CAP_FIELD_ALONE = [
    pytest.param({"subtype": SDK_CAP_SUBTYPE}, id="subtype-only"),
    pytest.param({"terminal_reason": SDK_CAP_TERMINAL_REASON}, id="terminal-reason-only"),
    pytest.param({"errors": [SDK_CAP_SENTENCE]}, id="errors-sentence-only"),
]


def _forge_truncated(tmp_path: Path, name: str, **overrides: object) -> Path:
    """Write the captured truncated message with the cap fields replaced wholesale.

    All three cap fields are dropped first, so a case that puts one back is
    testing that one and nothing else.
    """
    result = {
        key: value
        for key, value in _result_message(TURN_CAP_TRUNCATED_RUN).items()
        if key not in {"subtype", "terminal_reason", "errors"}
    }
    result.update(overrides)
    path = tmp_path / name
    path.write_text(json.dumps([result], indent=2, ensure_ascii=False), encoding="utf-8")
    return path


@pytest.mark.parametrize("field", _CAP_FIELD_ALONE)
def test_each_cap_field_names_the_shape_without_help_from_the_other_two(
    tmp_path: Path, field: dict[str, object]
) -> None:
    """An action release that renames one field must leave the other two working.

    That is the stated reason for reading three, and it is only true if each one
    reaches the verdict alone.
    """
    forged = _forge_truncated(tmp_path, "one-cap-field.json", **field)

    assert _classify(tmp_path, forged, step_outcome="failure").token == TURN_CAP_TRUNCATED


def test_stripping_every_cap_field_leaves_nothing_to_recognise(tmp_path: Path) -> None:
    """The other half: the cases above pass because of the field, not in spite of it.

    With all three gone the same message has no statement of its own cause left,
    and must fall back to the generic error rather than reaching this verdict by
    some other route.
    """
    forged = _forge_truncated(tmp_path, "no-cap-fields.json")

    assert _classify(tmp_path, forged, step_outcome="failure").token == AGENT_ERROR


def test_an_unrecognised_status_does_not_hide_a_truncation(tmp_path: Path) -> None:
    """A 500 beside the cap fields must not restore the headline being removed.

    Setting a cause for every non-empty status -- rather than only for the ones
    that name a meaning -- pre-empts the structural read and files a run that
    states its cause three times over as "no cause this classifier recognises".
    """
    forged = _forge_truncated(
        tmp_path,
        "truncated-with-a-500.json",
        subtype=SDK_CAP_SUBTYPE,
        terminal_reason=SDK_CAP_TERMINAL_REASON,
        errors=[SDK_CAP_SENTENCE],
        api_error_status=UNRECOGNISED_STATUS,
    )

    assert _classify(tmp_path, forged, step_outcome="failure").token == TURN_CAP_TRUNCATED


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        pytest.param(429, USAGE_LIMIT, id="usage-limit-outranks"),
        pytest.param(401, AUTH_FAILURE, id="auth-failure-outranks"),
    ],
)
def test_a_named_status_still_outranks_the_cap_fields(
    tmp_path: Path, status: int, expected: str
) -> None:
    """The ordering the fix must not have inverted.

    A rejected credential or an exhausted allowance is what an operator has to
    act on; that the conversation then ran out of turns is a consequence, not
    the cause, and naming the consequence sends them to fix the wrong thing.
    """
    forged = _forge_truncated(
        tmp_path,
        "truncated-with-a-named-status.json",
        subtype=SDK_CAP_SUBTYPE,
        terminal_reason=SDK_CAP_TERMINAL_REASON,
        errors=[SDK_CAP_SENTENCE],
        api_error_status=status,
    )

    assert _classify(tmp_path, forged, step_outcome="failure").token == expected


def test_an_unrecognised_status_is_not_second_guessed_from_the_model_s_prose(
    tmp_path: Path,
) -> None:
    """The prose fallback is for a run with NO status, and must stay that way.

    A 500 whose summary happens to mention a limit is not a usage limit, and
    advising a wait for a reset that will never come is worse than saying
    plainly that the cause is unrecognised.
    """
    forged = _forge_truncated(
        tmp_path,
        "unrecognised-status-with-limit-prose.json",
        api_error_status=UNRECOGNISED_STATUS,
        result="You've hit your weekly limit",
    )

    assert _classify(tmp_path, forged, step_outcome="failure").token == AGENT_ERROR


@pytest.mark.parametrize(
    "errors",
    [
        pytest.param([SDK_CAP_SENTENCE], id="array-of-one"),
        pytest.param(SDK_CAP_SENTENCE, id="bare-string"),
        pytest.param([SDK_CAP_SENTENCE, "and something else"], id="array-of-several"),
    ],
)
def test_the_errors_field_is_read_whatever_shape_the_sdk_gives_it(
    tmp_path: Path, errors: object
) -> None:
    """A retyped field must not take down the extraction it is only one seventh of.

    ``errors`` is read inside the single jq call that produces every field, so
    an iteration that aborts on a bare string aborts all seven and turns a run
    this script classifies perfectly into a classifier fault. The array shape is
    what was captured; nothing contracts the SDK to keep it.
    """
    forged = _forge_truncated(tmp_path, "errors-of-some-shape.json", errors=errors)

    assert _classify(tmp_path, forged, step_outcome="failure").token == TURN_CAP_TRUNCATED


def test_an_errored_result_is_classified_before_the_turn_cap_is_consulted(
    tmp_path: Path,
) -> None:
    """Ordering, pinned against the fixture that would slip through the wrong order.

    The usage-limit run carries ``subtype: "success"`` too -- only ``is_error``
    tells them apart. Its single turn is at the cap here, so a classifier that
    compared turns before reading ``is_error`` would report a weekly limit as a
    benign overrun and advise a retry that cannot succeed until the reset.
    """
    assert _token(tmp_path, USAGE_LIMIT_RUN, max_turns=1) == USAGE_LIMIT


def test_an_errored_result_is_never_reported_as_completed(tmp_path: Path) -> None:
    """A step that somehow exited clean does not overrule the model saying it failed.

    ``is_error`` is positive evidence that nothing was done; a green step
    outcome beside it is a contradiction, and the safe side of a contradiction
    is the one that gets looked at. (An unreadable execution file is the
    opposite case -- absence of evidence, not evidence of failure -- and is
    deliberately not asserted against a successful step anywhere here.)
    """
    assert _token(tmp_path, USAGE_LIMIT_RUN, step_outcome="success") != COMPLETED


# --- Causes: structural fields first, the result string as fallback --------


def test_the_weekly_limit_run_is_named_a_usage_limit(tmp_path: Path) -> None:
    """The one captured real red: 429, one turn, nothing attempted."""
    assert _token(tmp_path, USAGE_LIMIT_RUN) == USAGE_LIMIT


def test_an_expired_credential_is_not_folded_into_the_usage_limit(tmp_path: Path) -> None:
    """Waiting out a reset that will never come is the failure this separation prevents."""
    assert _token(tmp_path, AUTH_FAILURE_RUN) == AUTH_FAILURE


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        (429, USAGE_LIMIT),
        (401, AUTH_FAILURE),
        (403, AUTH_FAILURE),
        (500, AGENT_ERROR),
        (529, AGENT_ERROR),
    ],
)
def test_the_api_error_status_decides_the_cause(tmp_path: Path, status: int, expected: str) -> None:
    """The structural field wins: it is present, typed, and not written by a model."""
    forged = _forge(
        tmp_path,
        f"status-{status}.json",
        api_error_status=status,
        result=f"API Error: {status}",
    )

    assert _classify(tmp_path, forged, step_outcome="failure").token == expected


@pytest.mark.parametrize(
    ("result", "expected"),
    [
        ("Claude AI usage limit reached", USAGE_LIMIT),
        ("You've hit your weekly limit · resets 12pm (UTC)", USAGE_LIMIT),
        ("Error: rate limit exceeded, please retry later", USAGE_LIMIT),
        ("authentication_error: OAuth token has expired", AUTH_FAILURE),
        ("Error: the provided authentication credentials are invalid", AUTH_FAILURE),
    ],
)
def test_the_result_string_is_the_fallback_when_no_status_arrived(
    tmp_path: Path, result: str, expected: str
) -> None:
    """A transport-level failure can error without ever producing an HTTP status."""
    forged = _forge(tmp_path, "no-status.json", api_error_status=None, result=result)

    assert _classify(tmp_path, forged, step_outcome="failure").token == expected


def test_an_error_with_no_recognised_cause_is_an_agent_error(tmp_path: Path) -> None:
    """Unclassified is its own answer; guessing at a cause is how wrong advice ships."""
    forged = _forge(
        tmp_path,
        "unknown.json",
        api_error_status=None,
        result="Error: the tool call did not return",
    )

    assert _classify(tmp_path, forged, step_outcome="failure").token == AGENT_ERROR


# --- Time and money are not evidence ---------------------------------------


def test_the_two_one_turn_failures_are_indistinguishable_by_timing(tmp_path: Path) -> None:
    """States the premise the previous cases rest on, so it cannot rot unnoticed.

    If these two fixtures ever stop sharing a timing shape, a duration-keyed
    implementation could start passing every other case here while still giving
    the operator the wrong advice in production.
    """
    limit = _result_message(USAGE_LIMIT_RUN)
    auth = _result_message(AUTH_FAILURE_RUN)
    timing_keys = ("num_turns", "duration_ms", "duration_api_ms", "total_cost_usd")

    assert [limit[key] for key in timing_keys] == [auth[key] for key in timing_keys]
    assert _token(tmp_path, USAGE_LIMIT_RUN) != _token(tmp_path, AUTH_FAILURE_RUN)


def test_the_verdict_does_not_move_when_only_duration_and_cost_change(tmp_path: Path) -> None:
    """A long, expensive 429 is still a 429; a classifier keyed on either is wrong."""
    slow = _forge(tmp_path, "slow.json", duration_ms=1_800_000, total_cost_usd=12.5)

    assert _classify(tmp_path, slow, step_outcome="failure").token == USAGE_LIMIT


# --- Nothing to read is its own token, never a silent success --------------


def test_a_missing_execution_file_is_no_result(tmp_path: Path) -> None:
    """The action writes that file; its absence means the step died before the SDK spoke."""
    absent = tmp_path / "never-written.json"

    assert _classify(tmp_path, absent, step_outcome="failure").token == NO_RESULT


@pytest.mark.parametrize(
    ("name", "body"),
    [
        ("empty.json", ""),
        ("prose.txt", "Error: the runner ran out of disk\n"),
        ("truncated.json", '[{"type":"assistant","uuid":"a"'),
        ("empty-array.json", "[]"),
        ("an-object.json", '{"type": "result", "is_error": false}'),
    ],
)
def test_an_unreadable_or_resultless_file_is_no_result(
    tmp_path: Path, name: str, body: str
) -> None:
    """Anything that is not an array ending in a result message answers nothing.

    The bare object is deliberately in this list: the action writes an array,
    and a reader loose enough to accept a top-level object would also accept
    whatever else a half-written file happens to parse as.
    """
    path = tmp_path / name
    path.write_text(body, encoding="utf-8")

    assert _classify(tmp_path, path, step_outcome="failure").token == NO_RESULT


def test_a_transcript_that_never_reached_a_result_is_no_result(tmp_path: Path) -> None:
    """The synthesized truncated run: well-formed messages, no verdict among them."""
    assert _token(tmp_path, NO_RESULT_RUN) == NO_RESULT


def test_every_token_is_reachable_from_a_fixture() -> None:
    """A token nothing exercises is a branch nobody has ever run."""
    assert {scenario.expected for scenario in SCENARIOS} == set(TOKENS)


# --- What the run list and the next step actually see ----------------------


@pytest.mark.parametrize("scenario", SCENARIOS, ids=lambda s: s.label)
def test_the_token_is_published_as_a_step_output(tmp_path: Path, scenario: Scenario) -> None:
    """Whatever branches on the verdict reads it here, not from stdout."""
    result = _classify_scenario(tmp_path, scenario)

    assert result.token == scenario.expected
    assert _output_value(result.output, "outcome") == scenario.expected


@pytest.mark.parametrize("scenario", SCENARIOS, ids=lambda s: s.label)
def test_every_outcome_writes_one_headline_to_both_places(
    tmp_path: Path, scenario: Scenario
) -> None:
    """A verdict nobody can see from the run list is the condition being fixed."""
    result = _classify_scenario(tmp_path, scenario)
    headline = _output_value(result.output, "headline")

    assert headline.strip(), f"{scenario.expected} produced an empty headline"
    assert "\n" not in headline
    assert len(headline) <= HEADLINE_CHARACTER_CEILING
    assert headline in result.summary, "the step summary must show the operator the same line"


@pytest.mark.parametrize(
    ("fixture", "step_outcome", "max_turns", "must_mention"),
    [
        (TURN_CAP_44, "failure", LIVE_MAX_TURNS, ("turn", "44", "40")),
        (TURN_CAP_TRUNCATED_RUN, "failure", LIVE_MAX_TURNS, ("turn", "41", "40")),
        (USAGE_LIMIT_RUN, "failure", LIVE_MAX_TURNS, ("usage", "limit")),
        (AUTH_FAILURE_RUN, "failure", LIVE_MAX_TURNS, ("auth",)),
    ],
)
def test_the_headline_names_which_mode_occurred(
    tmp_path: Path,
    fixture: str,
    step_outcome: str,
    max_turns: int,
    must_mention: tuple[str, ...],
) -> None:
    """A bare word like failure is what the run list already said; name the mode.

    The overrun headline carries both numbers because "used more turns than the
    cap" is only actionable once you know how many more -- 44 against 40 raises
    the cap, 400 against 40 means something looped.
    """
    result = _classify(tmp_path, _RUNS / fixture, step_outcome=step_outcome, max_turns=max_turns)
    headline = _output_value(result.output, "headline").lower()

    for fragment in must_mention:
        assert fragment in headline, f"headline {headline!r} does not mention {fragment!r}"


def test_the_two_failure_modes_do_not_render_identically(tmp_path: Path) -> None:
    """They already look the same in the run list; that is the defect being closed."""
    overrun = _classify(tmp_path, _RUNS / TURN_CAP_44, step_outcome="failure")
    limited = _classify(tmp_path, _RUNS / USAGE_LIMIT_RUN, step_outcome="failure")

    assert _output_value(overrun.output, "headline") != _output_value(limited.output, "headline")


def test_the_summary_quotes_the_models_own_last_words(tmp_path: Path) -> None:
    """The reset time is the only actionable fact in a usage-limit run and must survive."""
    result = _classify(tmp_path, _RUNS / USAGE_LIMIT_RUN, step_outcome="failure")

    assert "resets 12pm" in result.summary


# --- A tooling fault is an exit, never a verdict ---------------------------


@pytest.mark.parametrize(
    "args",
    [
        (),
        ("--bogus",),
        ("--execution-file",),
        ("--step-outcome", "failure", "--max-turns", "40"),
        ("--execution-file", "/dev/null", "--max-turns", "40"),
        ("--execution-file", "/dev/null", "--step-outcome", "failure"),
        ("--execution-file", "/dev/null", "--step-outcome", "maybe", "--max-turns", "40"),
        ("--execution-file", "/dev/null", "--step-outcome", "failure", "--max-turns", "lots"),
    ],
)
def test_a_usage_fault_exits_nonzero_without_printing_a_verdict(
    tmp_path: Path, args: tuple[str, ...]
) -> None:
    """A mistyped invocation must never be readable as a statement about the run."""
    result = _run(tmp_path, *args)

    assert result.exit_code == EXIT_USAGE
    assert result.token not in TOKENS
    assert result.stderr.strip(), "a usage fault with a silent stderr cannot be diagnosed"


def test_a_usage_fault_still_leaves_the_step_outputs_defined(tmp_path: Path) -> None:
    """An unset output reads as the empty string, and every equality test then quietly fails.

    That is the same shape as the bug this change exists to close: a downstream
    ``if:`` comparing against nothing takes the "not that outcome" branch on
    every arm, and the workflow proceeds as though it had been told something.
    So the fault names itself in the outputs, using a value that is not one of
    the verdicts.
    """
    result = _run(tmp_path, "--bogus")

    assert _output_value(result.output, "outcome") not in TOKENS
    assert _output_value(result.output, "outcome").strip()
    assert _output_value(result.output, "headline").strip()
    assert result.summary.strip()


def test_the_classifier_is_executable() -> None:
    """The workflow invokes it directly; mode 100644 would exit 126 and look like a crash."""
    assert os.access(_CLASSIFY, os.X_OK)


# --- The action declining to run at all ------------------------------------
#
# Found by dispatching the real workflow from a branch. The Claude action
# refuses to run when the workflow file differs from the copy on the default
# branch, an anti-tamper check, and it declines by exiting SUCCESS having
# written no transcript at all. That is byte-for-byte the shape of a mis-wired
# classifier: step succeeded, nothing to read.
#
# The two need opposite answers. A self-skip is expected and benign on any
# branch that edits the workflow, and failing it manufactures exactly the false
# red this change exists to remove. A missing transcript on the default branch,
# where the file matches by definition, is a real fault.
#
# Nothing in the transcript separates them, because there is no transcript. The
# caller knows which case it is, since it knows its own ref, so the caller says
# so -- and the default is the strict reading: silence about the ref leaves a
# missing transcript a failure.


def test_a_missing_transcript_is_still_a_failure_by_default(tmp_path: Path) -> None:
    """The strict reading is the default; a skip has to be asked for."""
    assert _classify(tmp_path, tmp_path / "absent.json", step_outcome="success").token == NO_RESULT


def test_a_permitted_skip_is_named_rather_than_called_a_failure(tmp_path: Path) -> None:
    """The action declined to run, which is not the run having gone wrong."""
    result = _run(
        tmp_path,
        "--execution-file",
        str(tmp_path / "absent.json"),
        "--step-outcome",
        "success",
        "--max-turns",
        str(LIVE_MAX_TURNS),
        "--skip-permitted",
        "true",
    )

    assert result.token == SKIPPED
    assert result.exit_code == 0


def test_a_permitted_skip_still_reports_no_result_when_the_step_failed(tmp_path: Path) -> None:
    """A self-skip exits clean, so a failed step with no transcript is something else."""
    result = _run(
        tmp_path,
        "--execution-file",
        str(tmp_path / "absent.json"),
        "--step-outcome",
        "failure",
        "--max-turns",
        str(LIVE_MAX_TURNS),
        "--skip-permitted",
        "true",
    )

    assert result.token == NO_RESULT


def test_permitting_a_skip_does_not_reinterpret_a_transcript_that_exists(tmp_path: Path) -> None:
    """The flag licenses reading silence differently, never rewriting evidence."""
    result = _run(
        tmp_path,
        "--execution-file",
        str(_RUNS / USAGE_LIMIT_RUN),
        "--step-outcome",
        "failure",
        "--max-turns",
        str(LIVE_MAX_TURNS),
        "--skip-permitted",
        "true",
    )

    assert result.token == USAGE_LIMIT


def test_a_skip_flag_that_is_neither_true_nor_false_is_a_usage_fault(tmp_path: Path) -> None:
    """Guessing at an unrecognised value is how a strict default gets lost."""
    result = _run(
        tmp_path,
        "--execution-file",
        str(tmp_path / "absent.json"),
        "--step-outcome",
        "success",
        "--max-turns",
        str(LIVE_MAX_TURNS),
        "--skip-permitted",
        "maybe",
    )

    assert result.exit_code == EXIT_USAGE
    assert result.token == ""


def test_the_skip_headline_says_that_nothing_ran(tmp_path: Path) -> None:
    """An operator reading only the summary must not conclude the work happened."""
    result = _run(
        tmp_path,
        "--execution-file",
        str(tmp_path / "absent.json"),
        "--step-outcome",
        "success",
        "--max-turns",
        str(LIVE_MAX_TURNS),
        "--skip-permitted",
        "true",
    )

    assert "skip" in result.summary.lower()
    assert f"outcome={SKIPPED}" in result.output


@pytest.mark.parametrize("value", ["", " ", "maybe", "TRUE", "1", "yes"])
def test_only_the_two_literal_skip_values_are_accepted(tmp_path: Path, value: str) -> None:
    """Empty is included on purpose: it is what an absent default branch produces.

    The caller builds this from a workflow expression whose value comes out of
    GitHub's type-casting rules rather than being written out literally, and the
    caller normalises anything that is not exactly ``true`` before calling.
    Accepting a loose value here as "false" would be convenient and wrong:
    it would put the decision in this script, where the ref is not known, and
    silently paper over a caller that never wired the value at all. Rejecting it
    forces the caller to normalise, which is where the ref actually is.
    """
    result = _run(
        tmp_path,
        "--execution-file",
        str(tmp_path / "absent.json"),
        "--step-outcome",
        "success",
        "--max-turns",
        str(LIVE_MAX_TURNS),
        "--skip-permitted",
        value,
    )

    assert result.exit_code == EXIT_USAGE
    assert result.token == ""


# --- The header is the contract, so it has to be true --------------------------
#
# That script states its own design principle: the top-of-file comment IS the
# contract. Which makes a stale one worse than none, because the next reader
# trusts it and stops reading the code. Adding the skip verdict left the header
# claiming six tokens, calling the fault sentinel "not one of the six", and
# omitting the new flag from its synopsis -- three assertions that had quietly
# become false while every test still passed.
#
# Prose cannot be type-checked, but it can be diffed against the thing it
# describes, and these two checks are that diff.


def _header() -> str:
    """The comment block above the first line of executable shell."""
    return _CLASSIFY.read_text(encoding="utf-8").split("set -uo pipefail")[0]


def _tokens_named_in_header() -> set[str]:
    """The verdicts the header's contract table lists, by their table shape."""
    return set(re.findall(r"^#   ([a-z][a-z-]+) {2,}\S", _header(), re.MULTILINE))


def _flags_the_script_parses() -> set[str]:
    """Every long option the argument loop actually accepts."""
    body = _CLASSIFY.read_text(encoding="utf-8")
    return set(re.findall(r"^    (--[a-z-]+)\)", body, re.MULTILINE))


def test_the_header_lists_exactly_the_verdicts_the_script_emits() -> None:
    """A token table that has drifted from the code teaches the next reader wrong."""
    emitted = set(re.findall(r'verdict "([a-z-]+)"', _CLASSIFY.read_text(encoding="utf-8")))

    assert _tokens_named_in_header() == emitted, (
        f"header lists {sorted(_tokens_named_in_header())} but the script emits {sorted(emitted)}"
    )
    assert _tokens_named_in_header() == set(TOKENS), (
        "the header, the script and this module's TOKENS must all agree"
    )


def _usage_synopsis() -> str:
    """Just the ``# Usage:`` invocation lines, not the prose that follows them.

    Scoped deliberately. An earlier version of this check searched the whole
    header, which passed while the synopsis itself was missing the flag, because
    the prose underneath happened to mention it. A check that a word appears
    somewhere is not a check that the invocation is complete.
    """
    lines = _header().splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith("# Usage:"))
    synopsis = []
    for line in lines[start + 1 :]:
        if line.strip() in {"#", ""}:
            break
        synopsis.append(line)
    return "\n".join(synopsis)


def test_the_header_synopsis_names_every_flag_the_script_accepts() -> None:
    """A flag absent from the invocation block is a flag nobody discovers."""
    synopsis = _usage_synopsis()
    undocumented = [flag for flag in _flags_the_script_parses() if flag not in synopsis]

    assert not undocumented, (
        f"parsed but missing from the usage synopsis: {undocumented}\n{synopsis}"
    )
