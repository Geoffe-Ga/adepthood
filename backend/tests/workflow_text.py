"""Readers that let a test assert about a workflow's *code* rather than its prose.

Three test modules here grade GitHub Actions configuration, and each of them had
grown its own copy of the same handful of readers: strip the comment lines, pull
out the ``on:`` block, split ``jobs:`` into one body per job, read one step's
``run:`` command. Copies drift, and a drifted copy of a guard is a guard that
passes for a reason nobody checked. So they live here once and are imported.

Everything takes and returns plain text. Parsing with PyYAML is deliberately not
an option: PyYAML is absent from ``requirements.txt``, ``requirements-lock.txt``
and ``requirements-dev.txt``, so ``import yaml`` would turn every guard that
depends on it into a collection error on the 3.11 and 3.12 compat jobs -- a
louder version of the silence these guards exist to prevent.

The comment-stripping is the load-bearing part. Every workflow in this repo
carries a long header explaining why it does *not* do the dangerous thing, so a
raw substring search for ``pull_request_target`` or ``continue-on-error`` is
answered by the paragraph forbidding it. Reading code only, and reading comments
only, are both offered, because a rot check over the header needs the exact
inverse of what a disarm check over the YAML needs.

Each reader is exercised against deliberately violating fixtures in the modules
that use it; a reader nobody has watched fail is not known to work.
"""

from __future__ import annotations

import re
import textwrap

# A ``run:`` key, with whatever follows it on the same line.
_RUN_KEY = re.compile(r"^(?P<indent>\s*)run:\s*(?P<inline>.*?)\s*$")

# YAML block scalar introducers; anything else after ``run:`` is the command.
_BLOCK_SCALARS = ("|", "|-", "|+", ">", ">-", ">+")

# A ``uses:`` key, with or without the sequence dash, and with or without the
# version comment this repo requires beside every pin.
_USES_KEY = re.compile(r"^\s*(?:- )?uses:\s*(?P<action>\S+)\s*(?P<comment>#.*)?$")

# A ``with:`` key introducing an action's input mapping.
_WITH_KEY = re.compile(r"^(?P<indent>\s*)with:\s*$")

# One ``key: value`` entry inside such a mapping.
_MAPPING_ENTRY = re.compile(r"^(?P<indent>\s*)(?P<key>[A-Za-z_][\w.-]*):\s*(?P<value>.*?)\s*$")

# The workflow's own display name: ``name:`` at column zero. A job's ``name:``
# is indented, and conflating the two is the whole hazard this anchor avoids.
_WORKFLOW_NAME = re.compile(r"^name:\s*(?P<name>.+?)\s*$")

# Structure of a workflow file: ``jobs:`` at column zero, one job header two
# spaces in, and the next column-zero key ends the section.
_JOBS_KEY = re.compile(r"^jobs:\s*$")
_JOB_HEADER = re.compile(r"^  ([A-Za-z_][\w-]*):\s*$")
_TOP_LEVEL_KEY = re.compile(r"^\S")


def without_comment_lines(workflow_text: str) -> str:
    """Return the workflow with whole-line comments removed.

    YAML and the shell inside a ``run:`` block both comment with ``#``, so one
    filter serves both.

    Args:
        workflow_text: The workflow file's contents.

    Returns:
        The same text with every comment-only line dropped.
    """
    return "\n".join(
        line for line in workflow_text.splitlines() if not line.strip().startswith("#")
    )


def comment_lines(workflow_text: str) -> str:
    """Return only the workflow's whole-line comments.

    The exact inverse of :func:`without_comment_lines`. What that reader throws
    away so prose cannot satisfy a search, this one keeps, so a claim a header
    makes about its job can itself be asserted about.

    Args:
        workflow_text: The workflow file's contents.

    Returns:
        Every comment-only line, newline-joined.
    """
    return "\n".join(line for line in workflow_text.splitlines() if line.strip().startswith("#"))


def workflow_name(workflow_text: str) -> str | None:
    """Return the workflow's display name -- the string the Actions run list shows.

    Anchored at column zero, and that is load-bearing. A job also carries a
    ``name:``, indented under ``jobs:``, and a job name may be perfectly precise
    while the file's own name overclaims. A reader that accepted either would let
    the precise one answer a question asked about the advertised one.

    Args:
        workflow_text: The workflow file's contents.

    Returns:
        The first column-zero ``name:`` value, stripped of surrounding quotes, or
        ``None`` when the workflow declares no display name.
    """
    for line in workflow_text.splitlines():
        found = _WORKFLOW_NAME.match(line)
        if found is not None:
            return found.group("name").strip("\"'")
    return None


def trigger_block(workflow_text: str) -> str:
    """Return the body of the workflow's top-level ``on:`` block.

    Comments are stripped first, and that is the whole point: headers discuss
    triggers at length in prose, so a raw search over the file would be answered
    by an explanation of a trigger rather than by the trigger.

    Args:
        workflow_text: The workflow file's contents.

    Returns:
        Every line indented under the column-0 ``on:`` key, up to the next
        non-blank column-0 line, with leading and trailing blank lines removed.

    Raises:
        AssertionError: If the workflow declares no trigger block at all.
    """
    lines = without_comment_lines(workflow_text).splitlines()
    start = _line_index(lines, "on:")
    run: list[str] = [] if start is None else _indented_run(lines, start + 1)
    body = _without_edge_blanks(run)
    assert body, "the workflow has no trigger block"
    return "\n".join(body)


def jobs(workflow_text: str) -> dict[str, str]:
    """Return each job's body, keyed by job id.

    Two halves of a contract -- ``if: failure()`` and the reporter call, or a
    permissions block and the ``uses:`` it has to cover -- only mean anything in
    the *same* job, and a whole-file substring search cannot tell.

    Args:
        workflow_text: The workflow file's contents.

    Returns:
        A mapping from job id to that job's lines, newline-joined.
    """
    found: dict[str, str] = {}
    name: str | None = None
    body: list[str] = []
    inside = False
    for line in workflow_text.splitlines():
        if _JOBS_KEY.match(line):
            inside = True
            continue
        if not inside:
            continue
        if _TOP_LEVEL_KEY.match(line):
            break
        header = _JOB_HEADER.match(line)
        if header is None:
            body.append(line)
            continue
        if name is not None:
            found[name] = "\n".join(body)
        name, body = header.group(1), []
    if name is not None:
        found[name] = "\n".join(body)
    return found


def step_body(workflow_text: str, step_name: str) -> list[str]:
    """Return the lines belonging to one named step.

    Args:
        workflow_text: The workflow file's contents.
        step_name: The step's ``name:`` value.

    Returns:
        Every line after the step's own ``- name:`` line, up to the next item in
        the same sequence.

    Raises:
        AssertionError: If no step carries that name.
    """
    lines = workflow_text.splitlines()
    marker = re.compile(rf"^(?P<indent>\s*)- name: {re.escape(step_name)}\s*$")
    start, indent = None, ""
    for index, line in enumerate(lines):
        found = marker.match(line)
        if found:
            start, indent = index, found.group("indent")
            break
    assert start is not None, f"the workflow declares no step named {step_name!r}"
    body: list[str] = []
    for line in lines[start + 1 :]:
        if line.startswith(f"{indent}- "):
            break
        body.append(line)
    return body


def step_run_command(workflow_text: str, step_name: str) -> str:
    """Return one step's shell command, with comment lines and blanks removed.

    Comment-stripping is the point: the disarm this reader exists to catch is a
    ``#`` in front of the command, and a raw-text search reads a commented-out
    command as a live one.

    Args:
        workflow_text: The workflow file's contents.
        step_name: The step's ``name:`` value.

    Returns:
        The command the step runs, dedented, or the empty string when the step
        runs nothing at all.
    """
    body = step_body(workflow_text, step_name)
    for index, line in enumerate(body):
        key = _RUN_KEY.match(line)
        if key is None:
            continue
        if key.group("inline") not in _BLOCK_SCALARS:
            return key.group("inline")
        return _block_scalar(body[index + 1 :], len(key.group("indent")))
    return ""


def step_uses(workflow_text: str, step_name: str) -> str:
    """Return the action one named step invokes.

    Args:
        workflow_text: The workflow file's contents.
        step_name: The step's ``name:`` value.

    Returns:
        The ``uses:`` value, or the empty string when the step invokes no action
        -- which is what a commented-out ``uses:`` leaves behind.
    """
    for line in step_body(workflow_text, step_name):
        if line.strip().startswith("#"):
            continue
        found = _USES_KEY.match(line)
        if found is not None:
            return found.group("action")
    return ""


def step_inputs(workflow_text: str, step_name: str) -> dict[str, str]:
    """Return one named step's ``with:`` mapping as plain strings.

    An action's behaviour is configured by data, not by a command, so this is the
    equivalent of :func:`step_run_command` for a ``uses:`` step: it is what lets
    a guard assert that ``fail_action`` really is ``false`` rather than that the
    characters appear somewhere in the file.

    Args:
        workflow_text: The workflow file's contents.
        step_name: The step's ``name:`` value.

    Returns:
        Every ``key: value`` entry indented under the step's ``with:``, values
        stripped of surrounding quotes. Empty when the step declares no inputs.
    """
    body = step_body(workflow_text, step_name)
    for index, line in enumerate(body):
        key = _WITH_KEY.match(line)
        if key is not None:
            return _mapping(body[index + 1 :], len(key.group("indent")))
    return {}


def _mapping(lines: list[str], key_indent: int) -> dict[str, str]:
    """Read the ``key: value`` entries indented under a mapping key.

    Args:
        lines: The lines following the mapping key, within the same step.
        key_indent: Indentation of the mapping key itself; the block is whatever
            is indented further than that.

    Returns:
        One entry per live line, with surrounding quotes stripped from values.
    """
    entries: dict[str, str] = {}
    for line in lines:
        if not line.strip() or line.strip().startswith("#"):
            continue
        if _leading_spaces(line) <= key_indent:
            break
        entry = _MAPPING_ENTRY.match(line)
        if entry is not None:
            entries[entry.group("key")] = entry.group("value").strip("\"'")
    return entries


def _line_index(lines: list[str], key: str) -> int | None:
    """Return the index of the first line equal to a key, ignoring trailing space.

    Args:
        lines: The workflow's lines.
        key: The exact line to look for, indentation included.

    Returns:
        That line's index, or ``None`` when no line matches.
    """
    for index, line in enumerate(lines):
        if line.rstrip() == key:
            return index
    return None


def _indented_run(lines: list[str], start: int) -> list[str]:
    """Return the run of indented lines beginning at an index.

    Blank lines belong to the run: a blank line inside a YAML block does not end
    it, and trimming them is the caller's job.

    Args:
        lines: The workflow's lines.
        start: Index of the first line to consider.

    Returns:
        Lines from ``start`` up to the first non-blank line at column 0.
    """
    body: list[str] = []
    for line in lines[start:]:
        if line.strip() and not line.startswith((" ", "\t")):
            break
        body.append(line)
    return body


def _without_edge_blanks(lines: list[str]) -> list[str]:
    """Return the lines trimmed of leading and trailing blank ones.

    Args:
        lines: Lines that may begin or end with blank ones.

    Returns:
        The span from the first non-blank line to the last, or nothing when
        every line is blank.
    """
    filled = [index for index, line in enumerate(lines) if line.strip()]
    if not filled:
        return []
    return lines[filled[0] : filled[-1] + 1]


def _block_scalar(lines: list[str], key_indent: int) -> str:
    """Return the body of a ``run: |`` block, without comments or blank lines.

    Args:
        lines: The lines following the ``run:`` key, within the same step.
        key_indent: Indentation of the ``run:`` key itself; the block is
            whatever is indented further than that.

    Returns:
        The block's live commands, dedented and newline-joined.
    """
    kept = [
        line
        for line in lines
        if line.strip() and not line.strip().startswith("#") and _leading_spaces(line) > key_indent
    ]
    return textwrap.dedent("\n".join(kept)).strip()


def _leading_spaces(line: str) -> int:
    """Return how many spaces a line is indented by.

    Args:
        line: One line of the workflow.

    Returns:
        The count of leading spaces.
    """
    return len(line) - len(line.lstrip(" "))
