"""Tripwires for the Postgres integration lane's resolver and its CI wiring.

This module runs on the default SQLite lane and needs no Postgres. It exists
because the failure mode of an integration lane is not a red test -- it is a
green job that never touched Postgres. Two groups of tripwires cover that: a
truth table over the URL resolver, which must *raise* rather than skip once the
lane declares itself required, and a static read of ``backend-ci.yml`` asserting
the job is wired to a real service container and cannot be silently disarmed.

The workflow is parsed as plain text rather than with PyYAML on purpose. PyYAML
is absent from ``requirements.txt``, ``requirements-lock.txt`` and
``requirements-dev.txt``, so ``import yaml`` would turn this guard into a
collection error on the ``backend-compat`` job instead of a passing check.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from database import normalize_database_url
from tests.integration.pg_lane import (
    IntegrationLaneMisconfiguredError,
    integration_database_name,
    resolve_integration_database_url,
)

_URL_ENV = "TEST_POSTGRES_URL"
_REQUIRE_ENV = "INTEGRATION_LANE_REQUIRE_POSTGRES"
_WORKER_ENV = "PYTEST_XDIST_WORKER"

_WORKFLOW = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "backend-ci.yml"
_JOB_NAME = "backend-integration"

_ASYNCPG_SCHEME = "postgresql+asyncpg://"
_SAMPLE_AUTHORITY = "it:it@localhost:5432/adepthood_it"

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
    "not integration",
    "set +e",
    "|| true",
    "|| exit 0",
    "if: false",
    "if: ${{ false }}",
)

_JOBS_HEADER = re.compile(r"^jobs:[ \t]*$", re.MULTILINE)
_TOP_LEVEL_JOB = re.compile(r"^  (?P<name>[A-Za-z0-9_-]+):[ \t]*$", re.MULTILINE)
_SWALLOWED_PYTEST = re.compile(r"pytest[^\n]*\|\|")
_INTEGRATION_MARKER_ARG = re.compile(r"-m\s+[\"']?integration\b")


# --- Resolver truth table ------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (f"postgresql://{_SAMPLE_AUTHORITY}", f"{_ASYNCPG_SCHEME}{_SAMPLE_AUTHORITY}"),
        (f"postgres://{_SAMPLE_AUTHORITY}", f"{_ASYNCPG_SCHEME}{_SAMPLE_AUTHORITY}"),
        (f"{_ASYNCPG_SCHEME}{_SAMPLE_AUTHORITY}", f"{_ASYNCPG_SCHEME}{_SAMPLE_AUTHORITY}"),
    ],
)
def test_configured_url_comes_back_on_the_asyncpg_driver(raw: str, expected: str) -> None:
    """A configured URL is returned through the app's own scheme normalizer.

    Delegating rather than re-implementing is the point: the lane and the
    running app can never disagree about which driver a bare ``postgresql://``
    URL means, so a CI value copied from the ``migration-drift`` job works.
    """
    resolved = resolve_integration_database_url({_URL_ENV: raw})

    assert resolved == expected
    assert resolved == normalize_database_url(raw)


@pytest.mark.parametrize("flag", ["1", "true", "TRUE"])
def test_missing_url_raises_when_the_lane_declares_itself_required(flag: str) -> None:
    """With the require flag on, an absent URL is a hard error, never a skip.

    This is the single assertion the whole lane rests on: CI sets the flag, so
    a Postgres service that failed to come up cannot be quietly skipped past
    while the job still reports success.
    """
    with pytest.raises(IntegrationLaneMisconfiguredError) as excinfo:
        resolve_integration_database_url({_REQUIRE_ENV: flag})

    message = str(excinfo.value)
    assert _URL_ENV in message
    assert _REQUIRE_ENV in message


@pytest.mark.parametrize(
    "env",
    [
        {},
        {_REQUIRE_ENV: ""},
        {_REQUIRE_ENV: "0"},
        {_REQUIRE_ENV: "false"},
    ],
)
def test_missing_url_returns_none_when_the_lane_is_optional(env: dict[str, str]) -> None:
    """Without the require flag an absent URL yields ``None`` so the caller skips."""
    assert resolve_integration_database_url(env) is None


@pytest.mark.parametrize("blank", ["", "   "])
def test_blank_url_is_treated_as_unset(blank: str) -> None:
    """A declared-but-empty URL takes the unset branch instead of building a bad engine."""
    assert resolve_integration_database_url({_URL_ENV: blank}) is None


@pytest.mark.parametrize("blank", ["", "   "])
def test_blank_url_still_raises_when_required(blank: str) -> None:
    """An empty value in CI is a misconfiguration, not a licence to skip."""
    with pytest.raises(IntegrationLaneMisconfiguredError):
        resolve_integration_database_url({_URL_ENV: blank, _REQUIRE_ENV: "1"})


def test_resolver_reads_only_its_argument(monkeypatch: pytest.MonkeyPatch) -> None:
    """The resolver must not consult ``os.environ`` behind the caller's back.

    An ambient environment that could override the passed mapping would make
    the truth table above untestable and let a developer's shell decide what
    CI does.
    """
    monkeypatch.setenv(
        _URL_ENV,
        "postgresql://ambient:ambient@localhost:5432/ambient",  # pragma: allowlist secret
    )
    monkeypatch.setenv(_REQUIRE_ENV, "1")

    assert resolve_integration_database_url({}) is None


def test_database_name_defaults_to_the_master_worker() -> None:
    """Outside xdist the lane owns a single, stably-named database."""
    assert integration_database_name({}) == "adepthood_it_master"


def test_database_name_is_derived_from_the_xdist_worker() -> None:
    """Under xdist the worker id is what makes the database name unique."""
    assert integration_database_name({_WORKER_ENV: "gw0"}) == "adepthood_it_gw0"


def test_distinct_workers_get_distinct_databases() -> None:
    """Two workers must never share a database, or their migrations race."""
    assert integration_database_name({_WORKER_ENV: "gw0"}) != integration_database_name(
        {_WORKER_ENV: "gw1"}
    )


def test_database_name_reads_only_its_argument(monkeypatch: pytest.MonkeyPatch) -> None:
    """Same purity contract as the URL resolver, for the same reason."""
    monkeypatch.setenv(_WORKER_ENV, "gw7")

    assert integration_database_name({}) == "adepthood_it_master"


# --- Static wiring guard over backend-ci.yml -----------------------------


def _split_workflow() -> tuple[str, str]:
    """Return the workflow's trigger section and its ``jobs:`` section."""
    text = _WORKFLOW.read_text(encoding="utf-8")
    header = _JOBS_HEADER.search(text)
    if header is None:
        pytest.fail(f"no top-level `jobs:` key in {_WORKFLOW}")
    return text[: header.start()], text[header.end() :]


def _job_block(name: str) -> str:
    """Return one top-level job's YAML text, sliced at the next job key."""
    _, jobs = _split_workflow()
    matches = list(_TOP_LEVEL_JOB.finditer(jobs))
    for index, match in enumerate(matches):
        if match.group("name") != name:
            continue
        end = matches[index + 1].start() if index + 1 < len(matches) else len(jobs)
        return jobs[match.start() : end]
    found = sorted(m.group("name") for m in matches)
    pytest.fail(f"no `{name}:` job in {_WORKFLOW}; found {found}")


def _env_value(block: str, key: str) -> str:
    """Return the scalar assigned to ``key`` by the job, rejecting any shadowing.

    Reading the *first* match anywhere in the block would validate the job-level
    ``env:`` while a step-scoped ``env:`` further down silently overrode it at
    runtime -- the guard would stay green describing a value CI no longer uses.
    So the key is required to appear exactly once: a step-level override fails
    here rather than drifting past.
    """
    pattern = re.compile(rf"^\s*{re.escape(key)}:[ \t]+(?P<value>\S+)", re.MULTILINE)
    values = [match.group("value") for match in pattern.finditer(block)]
    if not values:
        pytest.fail(f"`{key}` is not set in the `{_JOB_NAME}` job block")
    if len(values) > 1:
        pytest.fail(
            f"`{key}` is assigned {len(values)} times in the `{_JOB_NAME}` job "
            f"block; a step-scoped override would shadow the job-level value at "
            f"runtime while this guard kept checking the wrong one"
        )
    return values[0].strip("\"'")


def _pytest_command(block: str) -> str:
    """Return every non-comment line of a job block that invokes pytest."""
    lines = [
        line.strip()
        for line in block.splitlines()
        if "pytest" in line and not line.strip().startswith("#")
    ]
    if not lines:
        pytest.fail(f"the `{_JOB_NAME}` job never invokes pytest")
    return "\n".join(lines)


def test_backend_integration_job_exists() -> None:
    """The lane is only real once a job in backend-ci.yml runs it."""
    assert _job_block(_JOB_NAME).startswith(f"  {_JOB_NAME}:")


def test_job_provisions_a_postgres_16_service() -> None:
    """The lane must run against the same major version production uses."""
    assert re.search(r"image:[ \t]*postgres:16\b", _job_block(_JOB_NAME))


def test_job_gates_on_the_service_becoming_ready() -> None:
    """A container that never accepts connections must fail the job, not be raced.

    Without a health check the steps start immediately and the lane's outcome
    depends on whether Postgres happened to finish booting first.
    """
    assert "pg_isready" in _job_block(_JOB_NAME)


def test_job_points_the_lane_at_postgres() -> None:
    """The configured URL must resolve to asyncpg-on-Postgres, not a SQLite fallback.

    Feeding the workflow's literal through the production resolver -- rather
    than string-matching it here -- means a value like ``sqlite+aiosqlite://``
    fails this test instead of quietly giving the lane a fake database.
    """
    configured = _env_value(_job_block(_JOB_NAME), _URL_ENV)

    resolved = resolve_integration_database_url({_URL_ENV: configured})

    assert resolved is not None
    assert resolved.startswith(_ASYNCPG_SCHEME)


def test_job_declares_the_lane_required() -> None:
    """The workflow's require-flag literal must read as truthy to the resolver itself.

    Asserting through ``resolve_integration_database_url`` rather than against a
    restated list of truthy spellings keeps the workflow and the resolver from
    drifting into a state where CI thinks the lane is required and the code
    does not.
    """
    configured = _env_value(_job_block(_JOB_NAME), _REQUIRE_ENV)

    with pytest.raises(IntegrationLaneMisconfiguredError):
        resolve_integration_database_url({_REQUIRE_ENV: configured})


def test_job_runs_the_integration_marker_with_coverage_off() -> None:
    """The lane selects by marker and leaves the repo-wide coverage gate alone."""
    command = _pytest_command(_job_block(_JOB_NAME))

    assert _INTEGRATION_MARKER_ARG.search(command)
    assert "--no-cov" in command


@pytest.mark.parametrize("fragment", _DISARMING_FRAGMENTS)
def test_job_carries_no_disarming_fragment(fragment: str) -> None:
    """None of the known ways to make a red lane report success may appear."""
    assert fragment not in _job_block(_JOB_NAME)


def test_job_does_not_swallow_pytests_exit_code() -> None:
    """A ``pytest ... || <fallback>`` shell chain hides every failure the lane finds."""
    assert _SWALLOWED_PYTEST.search(_job_block(_JOB_NAME)) is None


def test_workflow_keeps_its_concurrency_block() -> None:
    """Regression guard: cancelling superseded PR runs must survive this change."""
    triggers, _ = _split_workflow()

    assert re.search(r"^concurrency:[ \t]*$", triggers, re.MULTILINE)
    assert re.search(r"^  group:[ \t]+\S", triggers, re.MULTILINE)
    assert re.search(r"^  cancel-in-progress:[ \t]+\S", triggers, re.MULTILINE)


def test_workflow_keeps_its_backend_path_filters() -> None:
    """Regression guard: both triggers stay scoped to backend changes.

    Dropping the filters would run the whole backend suite on every frontend
    commit; dropping the ``backend/**`` entry would stop running it on the
    changes that matter.
    """
    triggers, _ = _split_workflow()
    expected_triggers = 2

    assert triggers.count("paths:") == expected_triggers
    assert triggers.count('- "backend/**"') == expected_triggers
