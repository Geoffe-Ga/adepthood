"""backend-compat must report every Python leg, and must keep canarying transitives.

``backend-compat`` is the one job that installs ``requirements.txt`` unresolved
rather than ``requirements-lock.txt`` *and then runs the backend test suite*.
(The scan workflows' analyzer toolboxes also install the unresolved file, but
run no tests; the header of ``requirements.txt`` lists every such reader.)
Transitives such as Starlette float to their newest compatible release there, so
this job is where an upstream release that breaks the app shows up first -- it is
the dependency canary.

In #2923 that is exactly what happened: Starlette 1.7.0 began adding ``Origin``
to ``Vary``, the 3.11 leg went red, and GitHub's default ``fail-fast: true``
cancelled the 3.13 leg before it reported anything. A canary that silences half
of itself on the first red tells you less precisely when you most need it. So
``fail-fast: false`` is asserted here, read from the job's ``strategy:`` block
as code, never from prose that merely mentions it.

The second guard pins the canary's shape: if the install step ever switched to
the lock, the job would stop testing anything the other jobs do not, and nothing
else would notice.

Parsed as plain text through :mod:`tests.workflow_text`, for the reason that
module gives: PyYAML is in no requirements file.
"""

from __future__ import annotations

import textwrap
from pathlib import Path

from tests.workflow_text import job_mapping, jobs, step_run_command, without_comment_lines

_REPO_ROOT = Path(__file__).resolve().parents[3]
_BACKEND_CI = _REPO_ROOT / ".github" / "workflows" / "backend-ci.yml"

_COMPAT_JOB = "backend-compat"
_INSTALL_STEP = "Install backend deps"
_UNRESOLVED_INSTALL = "-r backend/requirements.txt"
_LOCK_FILE = "requirements-lock.txt"

# A job body as :func:`jobs` hands it over: every line still indented as it sat
# under ``jobs:``, so the job's own keys start four spaces in.
_JOB_WITH_EVERY_DECOY = textwrap.dedent(
    """\
    jobs:
      compat:
        runs-on: ubuntu-latest
        strategy:
          fail-fast: false
          max-parallel: 2
          matrix:
            python-version: ["3.11", "3.13"]
            include:
              - experimental: true
        steps:
          - name: Set up Python
            uses: actions/setup-python@v6
            with:
              fail-fast: true
              python-version: "3.13"
    """
)


def _compat_body(workflow_text: str) -> str:
    """Return one fixture's ``compat`` job body, comments stripped as callers do."""
    return jobs(without_comment_lines(workflow_text))["compat"]


def test_job_mapping_reads_only_scalar_entries_under_the_named_block() -> None:
    """Direct scalar children of ``strategy:`` are read; nested ``matrix:`` is not."""
    strategy = job_mapping(_compat_body(_JOB_WITH_EVERY_DECOY), "strategy")

    assert strategy == {"fail-fast": "false", "max-parallel": "2"}


def test_job_mapping_ignores_a_key_that_lives_under_a_step() -> None:
    """A ``fail-fast`` under a step's ``with:`` is an action input, not the strategy."""
    only_a_step_says_it = textwrap.dedent(
        """\
        jobs:
          compat:
            strategy:
              matrix:
                python-version: ["3.11", "3.13"]
            steps:
              - name: Set up Python
                with:
                  fail-fast: false
        """
    )

    assert "fail-fast" not in job_mapping(_compat_body(only_a_step_says_it), "strategy")


def test_job_mapping_ignores_a_commented_out_key() -> None:
    """A ``# fail-fast: false`` line documents a setting; it does not make one."""
    commented_out = textwrap.dedent(
        """\
        jobs:
          compat:
            strategy:
              # fail-fast: false
              matrix:
                python-version: ["3.11", "3.13"]
        """
    )

    assert "fail-fast" not in job_mapping(_compat_body(commented_out), "strategy")


def test_job_mapping_stops_at_the_dedent() -> None:
    """A sibling key after the block ends the block, whatever it is called.

    The sibling ``defaults:`` block puts its own ``fail-fast`` at exactly the
    indentation ``strategy:``'s children use, so only the dedent -- not the
    child-indentation filter -- can keep it out.
    """
    sibling_after = textwrap.dedent(
        """\
        jobs:
          compat:
            strategy:
              matrix:
                python-version: ["3.11"]
            fail-fast: false
            defaults:
              fail-fast: false
            timeout-minutes: 10
        """
    )

    assert job_mapping(_compat_body(sibling_after), "strategy") == {}


def test_job_mapping_does_not_match_a_nested_key_of_the_same_name() -> None:
    """Only the job's own ``strategy:`` counts, not one buried deeper in the job."""
    nested_only = textwrap.dedent(
        """\
        jobs:
          compat:
            steps:
              - name: Deploy
                with:
                  strategy:
                    fail-fast: false
        """
    )

    assert job_mapping(_compat_body(nested_only), "strategy") == {}


def test_job_mapping_drops_a_trailing_comment_from_a_value() -> None:
    """``fail-fast: false  # why`` configures ``false``; the comment is not the value."""
    commented_value = textwrap.dedent(
        """\
        jobs:
          compat:
            strategy:
              fail-fast: false  # keep every leg
              max-parallel: "2"  # quoted, then commented
              matrix:
                python-version: ["3.11", "3.13"]
        """
    )

    assert job_mapping(_compat_body(commented_value), "strategy") == {
        "fail-fast": "false",
        "max-parallel": "2",
    }


def test_job_mapping_finds_a_key_line_carrying_a_trailing_comment() -> None:
    """``strategy:  # canary`` still opens the strategy block."""
    commented_key = textwrap.dedent(
        """\
        jobs:
          compat:
            strategy:  # canary
              fail-fast: false
        """
    )

    assert job_mapping(_compat_body(commented_key), "strategy") == {"fail-fast": "false"}
    # Without whitespace before it, ``#`` is not a comment: YAML reads
    # ``strategy:#x`` as one plain scalar, not as the strategy key.
    glued = commented_key.replace("strategy:  # canary", "strategy:#x")
    assert job_mapping(_compat_body(glued), "strategy") == {}


def test_job_mapping_keeps_a_hash_that_is_part_of_the_value() -> None:
    """A ``#`` inside quotes, or not preceded by a space, is data rather than a comment."""
    hashes_in_values = textwrap.dedent(
        """\
        jobs:
          compat:
            strategy:
              double: "a # b"  # trailing
              single: 'c # d'
              bare: e#f
        """
    )

    assert job_mapping(_compat_body(hashes_in_values), "strategy") == {
        "double": "a # b",
        "single": "c # d",
        "bare": "e#f",
    }


def test_job_mapping_returns_nothing_for_an_absent_or_flow_style_block() -> None:
    """Absent and flow-style ``strategy: {...}`` both read as empty, i.e. "missing"."""
    flow_style = textwrap.dedent(
        """\
        jobs:
          compat:
            strategy: {fail-fast: false}
            runs-on: ubuntu-latest
        """
    )

    assert job_mapping(_compat_body(flow_style), "strategy") == {}
    assert job_mapping(_compat_body(flow_style), "services") == {}


def test_backend_compat_runs_every_python_leg_to_completion() -> None:
    """A red leg must not cancel its siblings: the canary reports every Python."""
    workflow = without_comment_lines(_BACKEND_CI.read_text(encoding="utf-8"))

    strategy = job_mapping(jobs(workflow)[_COMPAT_JOB], "strategy")

    assert strategy.get("fail-fast") == "false", (
        "a red 3.11 leg must not cancel 3.13 — backend-compat is the "
        "transitive-dependency canary and must report every Python leg (#2923); "
        f"its strategy block reads {strategy!r}"
    )


def test_backend_compat_installs_the_unpinned_requirements_not_the_lock() -> None:
    """The canary installs ``requirements.txt`` so transitives float; the lock would blind it."""
    compat = jobs(_BACKEND_CI.read_text(encoding="utf-8"))[_COMPAT_JOB]

    command = step_run_command(compat, _INSTALL_STEP)

    assert _UNRESOLVED_INSTALL in command, (
        f"backend-compat must install {_UNRESOLVED_INSTALL!r} so transitives float "
        f"to their newest release (#2923); its install step runs {command!r}"
    )
    assert _LOCK_FILE not in command, (
        f"backend-compat must not install {_LOCK_FILE}: the other backend test jobs "
        f"already test the lock, and the canary would stop seeing new transitives (#2923)"
    )
