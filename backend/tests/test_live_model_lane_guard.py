"""Tripwires for the live model lane's resolvers and its scheduled wiring.

This module runs on the default lane: no network, no key, no cost. It exists
because the failure mode of a live lane is not a red test -- it is a green job
that never spoke to the provider, or a red job that only means the network
hiccupped. Three groups of tripwires cover that:

* a truth table over the opt-in resolver, which must *raise* rather than skip
  once the lane has been armed;
* a truth table over the transport-vs-verdict classifier, including the
  recorded catalogue that proves the bug this lane was built for;
* a static read of ``live-model-check.yml`` asserting the job is wired to run
  the lane armed, cannot be silently disarmed, and reports what it found.

The workflow is parsed as plain text rather than with PyYAML on purpose: PyYAML
is absent from the backend requirements files, so ``import yaml`` would turn
this guard into a collection error on the compat job instead of a check.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from services.botmason import PROVIDER_REGISTRY
from services.llm_pricing import MODEL_PRICING
from tests.live.model_lane import (
    KEY_ENV,
    OPT_IN_ENV,
    RETIREMENT_SENTINEL,
    CatalogueOutcome,
    LiveModelLaneMisconfiguredError,
    classify_catalogue_response,
    resolve_live_api_key,
    retired_models,
)

_KEY = "sk-ant-not-a-real-key"  # pragma: allowlist secret

_WORKFLOW = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "live-model-check.yml"

_PROVIDER = "anthropic"

# Anthropic's published catalogue as read on 2026-08-23, the day the retirement
# was found. Recorded so the discovery stays reproducible offline: the id the
# default used to name is absent from it, and that absence is the whole bug.
# It is evidence, not an expectation -- no test asserts today's allowlist
# against it, because the catalogue moves and a snapshot would go stale into a
# false alarm.
_CATALOGUE_2026_08_23 = frozenset(
    {
        "claude-opus-5",
        "claude-sonnet-5",
        "claude-fable-5",
        "claude-opus-4-8",
        "claude-opus-4-7",
        "claude-sonnet-4-6",
        "claude-opus-4-6",
        "claude-opus-4-5-20251101",
        "claude-haiku-4-5-20251001",
        "claude-sonnet-4-5-20250929",
    }
)

_RETIRED_DEFAULT = "claude-sonnet-4-20250514"

# Text fragments that would leave the job structurally present but toothless:
# a red lane reported as success, a collection-only run, a marker filter that
# excludes the very tests the lane exists to run, or a shell that swallows
# pytest's exit code.
_DISARMING_FRAGMENTS = (
    "continue-on-error",
    "--no-strict-markers",
    "--collect-only",
    "--deselect",
    "--ignore",
    "-k ",
    "not live",
    "set +e",
    "|| true",
    "|| exit 0",
    "if: false",
)


# --- Opt-in resolver truth table -----------------------------------------


@pytest.mark.parametrize("flag", ["1", "true", "TRUE", "yes"])
def test_armed_lane_returns_the_key(flag: str) -> None:
    """With the lane armed and a key present, the caller gets the key."""
    assert resolve_live_api_key({OPT_IN_ENV: flag, KEY_ENV: _KEY}) == _KEY


@pytest.mark.parametrize(
    "env",
    [
        {},
        {OPT_IN_ENV: ""},
        {OPT_IN_ENV: "0"},
        {OPT_IN_ENV: "false"},
        {OPT_IN_ENV: "off"},
    ],
)
def test_unarmed_lane_returns_none_even_with_a_key(env: dict[str, str]) -> None:
    """A key in the environment must never be enough to arm the lane.

    Developers export ``ANTHROPIC_API_KEY`` for unrelated work. If its presence
    armed this lane, an ordinary ``pytest`` run would start making network
    calls on a paid credential without anyone asking for it.
    """
    assert resolve_live_api_key({**env, KEY_ENV: _KEY}) is None


@pytest.mark.parametrize("blank", ["", "   "])
def test_armed_lane_without_a_key_raises_instead_of_skipping(blank: str) -> None:
    """This is the assertion the scheduled job rests on.

    Arming is deliberate, so a missing credential is a misconfiguration. Were
    it a skip, the weekly run would report success forever while checking
    nothing -- which is exactly how a sibling LLM workflow in this repo failed
    six consecutive runs unnoticed.
    """
    with pytest.raises(LiveModelLaneMisconfiguredError) as excinfo:
        resolve_live_api_key({OPT_IN_ENV: "1", KEY_ENV: blank})

    message = str(excinfo.value)
    assert KEY_ENV in message
    assert OPT_IN_ENV in message


def test_resolver_never_echoes_the_key_it_was_given() -> None:
    """A misconfiguration message must not leak a credential into CI logs."""
    with pytest.raises(LiveModelLaneMisconfiguredError) as excinfo:
        resolve_live_api_key({OPT_IN_ENV: "1"})

    assert _KEY not in str(excinfo.value)


def test_resolver_reads_only_its_argument(monkeypatch: pytest.MonkeyPatch) -> None:
    """The resolver must not consult ``os.environ`` behind the caller's back."""
    monkeypatch.setenv(OPT_IN_ENV, "1")
    monkeypatch.setenv(KEY_ENV, _KEY)

    assert resolve_live_api_key({}) is None


# --- Transport-vs-verdict classifier -------------------------------------


def test_two_hundred_is_the_only_status_that_permits_a_verdict() -> None:
    """Only a catalogue we actually read can retire a model."""
    assert classify_catalogue_response(200) is CatalogueOutcome.USABLE


@pytest.mark.parametrize("status", [429, 500, 502, 503, 504, 599])
def test_rate_limits_and_server_errors_are_unreachable_not_verdicts(status: int) -> None:
    """Provider back-pressure says nothing about any model, so it must not fail the build.

    A live check that goes red on a network blip is a false alarm generator,
    and a false alarm generator is ignored -- which costs exactly as much as
    having no check at all.
    """
    assert classify_catalogue_response(status) is CatalogueOutcome.UNREACHABLE


@pytest.mark.parametrize("status", [400, 401, 403, 404, 410])
def test_credential_and_endpoint_faults_are_misconfiguration(status: int) -> None:
    """The states that would make the lane permanently blind must be loud.

    An expired key (401/403) or a catalogue endpoint that has moved (404) does
    not resolve itself next week the way a 5xx does; treating either as a skip
    would retire the check silently.
    """
    assert classify_catalogue_response(status) is CatalogueOutcome.MISCONFIGURED


# --- The verdict itself --------------------------------------------------


def test_recorded_catalogue_shows_the_old_default_was_retired() -> None:
    """The bug, reproduced offline against the catalogue read the day it was found."""
    assert retired_models({_RETIRED_DEFAULT}, _CATALOGUE_2026_08_23) == [_RETIRED_DEFAULT]


def test_no_retirements_when_every_allowlisted_id_is_published() -> None:
    """A published allowlist yields an empty verdict, not a truthy near-miss."""
    assert retired_models({"claude-sonnet-5", "claude-opus-5"}, _CATALOGUE_2026_08_23) == []


def test_verdict_is_sorted_and_deduplicated() -> None:
    """Deterministic output, so the filed issue reads the same on every run."""
    assert retired_models(["z-model", "a-model", "a-model"], []) == ["a-model", "z-model"]


# --- Registry invariants the live lane assumes ---------------------------


def test_the_retired_default_is_gone_from_every_anthropic_set() -> None:
    """The id that 404s must not survive anywhere a request could select it."""
    spec = PROVIDER_REGISTRY[_PROVIDER]

    assert spec.default_model != _RETIRED_DEFAULT
    assert _RETIRED_DEFAULT not in spec.allowed_models
    assert _RETIRED_DEFAULT not in spec.vision_models
    assert _RETIRED_DEFAULT not in MODEL_PRICING


@pytest.mark.parametrize("provider", sorted(PROVIDER_REGISTRY))
def test_every_default_model_is_selectable_for_vision(provider: str) -> None:
    """ADR-3 transcription must work on the documented default configuration.

    ``vision_models`` is audited independently of ``allowed_models``, so a
    default that is allowlisted but not vision-capable would leave journal
    single-page transcription rejecting its own default with HTTP 422.
    """
    spec = PROVIDER_REGISTRY[provider]

    assert spec.default_model in spec.allowed_models
    assert spec.default_model in spec.vision_models


@pytest.mark.parametrize("provider", sorted(PROVIDER_REGISTRY))
def test_vision_models_are_a_subset_of_allowed_models(provider: str) -> None:
    """A vision-only id could never be selected, so it would be dead config."""
    spec = PROVIDER_REGISTRY[provider]

    assert spec.vision_models <= spec.allowed_models


# --- Static wiring guard over live-model-check.yml -----------------------


def _workflow_text() -> str:
    """Return the scheduled workflow's source."""
    return _WORKFLOW.read_text(encoding="utf-8")


def test_the_lane_runs_armed_on_a_schedule() -> None:
    """Unarmed, the job would skip every week and report success."""
    text = _workflow_text()

    assert "schedule:" in text
    assert "workflow_dispatch:" in text
    assert f'{OPT_IN_ENV}: "1"' in text
    assert f"{KEY_ENV}: " in text


def test_the_lane_is_never_triggered_by_ordinary_code_changes() -> None:
    """A paid, networked check on every PR would be both costly and flaky."""
    text = _workflow_text()

    assert "\n  push:" not in text
    assert "\n  pull_request:" not in text


def test_the_job_invokes_the_live_marker() -> None:
    """Running ``pytest`` without ``-m live`` here would check nothing at all."""
    text = _workflow_text()

    assert "python -m pytest tests/live -m live" in text


def test_the_pipeline_cannot_swallow_a_failing_exit_code() -> None:
    """The pytest run is piped into ``tee``; without ``pipefail`` that always passes."""
    text = _workflow_text()

    assert "set -euo pipefail" in text


@pytest.mark.parametrize("fragment", _DISARMING_FRAGMENTS)
def test_the_job_is_not_disarmed(fragment: str) -> None:
    """Each fragment would leave the job present but incapable of failing."""
    assert fragment not in _workflow_text()


def test_a_retirement_files_an_issue_rather_than_only_a_red_run() -> None:
    """A red scheduled run is not seen; an issue in the backlog is.

    The sentinel is what lets the reporting step tell a retired model apart
    from a lane that could not see, so it must stay in step with the assertion
    messages the lane emits.
    """
    text = _workflow_text()

    assert RETIREMENT_SENTINEL in text
    assert "gh issue create" in text


def test_a_skipped_run_is_annotated_rather_than_reported_as_a_clean_pass() -> None:
    """A green job that reached no verdict must say so, or it is indistinguishable."""
    text = _workflow_text()

    assert "::warning::" in text
    assert "GITHUB_STEP_SUMMARY" in text
