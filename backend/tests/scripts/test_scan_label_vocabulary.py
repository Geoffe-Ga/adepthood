"""A label an instruction applies must be a label something in this repo creates.

The grooming prompt promotes a completed scan issue with ``gh issue edit
--add-label agent-ready --remove-label needs-triage``. There is no
``needs-triage`` label in this repository, so that branch has never once done
what it says. ``gh`` does not fail loudly on it in a way anybody reads, the
grooming run reports success, and an issue that a human finished by hand keeps
whatever labels it already had. The correct label is ``needs-spec``: that is the
token ``scripts/ralph/pick-next.sh`` names in its default exclude list, so it is
the only one that actually keeps an unfinished issue away from the fleet.
``needs-triage`` is not in that list, which makes it worse than a typo -- an
issue wearing it reads as "held back" while remaining perfectly pickable.

WHAT COUNTS AS A DEFINED LABEL, AND WHY IT HAS TO BE THIS. An offline pytest
cannot ask GitHub which labels exist, and a hand-maintained list of them here
would be one more copy to drift. The only definition knowable from inside the
repository is one the repository itself performs: something in the tree runs the
command that creates the label. Choosing that definition also makes "add a
label to the vocabulary" and "make something create it" the same edit, which is
precisely the invariant whose absence produced this defect.

Two things create labels here, and both are legitimate. The first is
``scripts/setup-scan-labels.sh``, the pipeline's declaration of its own
vocabulary. It is EXECUTED here rather than parsed, with a stubbed ``gh`` first
on ``PATH`` that prints each name it is asked to create. A regex would read the
``"$1"`` inside the script's ``label()`` helper and would miss every name
produced by its ``for scan in ...`` loop, so the only way to learn what the
script creates is to let it say so. The second is a literal ``gh label create
<name>`` inside a workflow: two workflows self-bootstrap a label they own -- the
graph build creates ``graph-staleness``, the weekly playbook creates
``playbook`` -- and those names are as defined as any other.

Four labels are allowlisted out of the created-in-tree rule because something
outside the tree creates them; each says which, at its entry below. An
allowlist is a standing permission, so a test here insists every entry is
actually used, on the grounds that unused permission is the kind that gets
inherited by the wrong thing later.

THE TWO CHECKS HAVE DIFFERENT SCOPES ON PURPOSE. Check A grades commands --
text that will be executed against the real repository -- and so it reads
``prompts/`` and ``.github/workflows/``, where the executable instructions live.
It deliberately does not read ``.claude/skills/``, whose label mentions are
illustrative placeholders inside prose examples (``label1,label2``,
``<priority>``, ``enhancement,performance``) rather than this repository's
operative vocabulary; grading them would produce noise and teach the next reader
to widen the allowlist. Check B grades a documentation defect instead -- naming
a label the repository does not define teaches whoever reads it to reach for a
label that does nothing -- and a documentation defect is a defect wherever it is
written, so Check B additionally reads the skills, the agent definitions and
`scripts/`, where the fleet's runbooks name the same vocabulary.

Check B carries exactly one exemption, ``.claude/skills/flare/``. That skill's
``SKILL.md`` and its ``references/label-guide.md`` document ``needs-triage``
specifically as the trap, and that record is the reason the right label is
knowable at all. A guard that deleted its own evidence would leave the repo
worse off than no guard. (The recorded Claude transcripts under
``tests/fixtures/claude_runs/`` also contain the string, but they sit outside
all three roots and need no exemption -- they are captured runs consumed by the
outcome-classifier tests, and editing one would falsify a fixture.)

Parsed as plain text. PyYAML is importable here only transitively and is
declared in no requirements file, a fact recorded deliberately in
``requirements-dast.txt``; importing it would turn this module into a collection
error on the 3.11 and 3.12 compat jobs.

Every check takes the tree it grades as an argument, so the same code that
grades the real repository is pointed below at trees built to fail it. A gate
never observed to fail is not known to be a gate.
"""

from __future__ import annotations

import os
import re
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[3]

_BOOTSTRAP_SCRIPT = Path("scripts") / "setup-scan-labels.sh"
_WORKFLOWS = Path(".github") / "workflows"
_PROMPTS = Path("prompts")
_SKILLS = Path(".claude") / "skills"
_AGENTS = Path(".claude") / "agents"
_SCRIPTS = Path("scripts")

# Where executable instructions live. A prompt is a command the model will run;
# a workflow is a command the runner will run.
_COMMAND_ROOTS = (_PROMPTS, _WORKFLOWS)

# Where a label name is asserted to a reader. Wider than the command roots
# because a wrong name in prose is wrong wherever it is written, and an agent
# reading a skill, an agent definition or a runbook acts on the name it finds
# there exactly as it would on one inside a command.
#
# `scripts/` is read for prose but deliberately NOT as a command root: its shell
# files document their own flags, so a usage line reading `--label  Issue label
# to check` would be extracted as a label named `Issue`. The wrong name in a
# runbook is still worth catching; the flag parser just is not the tool for it.
_PROSE_ROOTS = (_PROMPTS, _WORKFLOWS, _SKILLS, _AGENTS, _SCRIPTS)

# Labels created by something outside this repository, each with the something.
_CREATED_ELSEWHERE = frozenset(
    {
        "bug",  # GitHub creates it with the repository.
        "dependencies",  # Dependabot mints it on its first pull request.
        "infra",  # Repo-wide topic label, the failure reporter's default beside `bug`.
        "backend",  # Repo-wide topic label, older than the scan pipeline.
    }
)

# A label that must not be named anywhere, because naming it teaches the reader
# to reach for something inert. `needs-triage` is absent from `pick-next.sh`'s
# default exclude set, so an issue carrying it reads as held back while staying
# pickable -- the exact trap the flare label guide exists to describe.
# `needs-spec` is the label that actually excludes.
_LABELS_THE_REPO_DOES_NOT_DEFINE = frozenset({"needs-triage"})

# Naming one bad label is a blocklist of one, and the next wrong name gets
# found the way this one was: a year later, by noticing that a branch keyed on
# it had never fired. Every readiness label this repo uses is spelled
# `needs-<something>`, so the family is enumerable and can be checked as a
# family instead.
_READINESS_FAMILY = re.compile(r"\bneeds-[a-z][a-z-]*")

# The one member of that family that is not a label at all: a verdict in an
# audit's report table, listed beside `fine` and `edited`, which are plainly
# not labels either. Held as a named exception rather than by narrowing the
# pattern, because any narrowing that excluded it would also exclude a real
# label spelled the same way.
_NOT_A_LABEL = frozenset({"needs-owner"})

# The one place allowed to name a retired label: the record that documents it as
# the trap. See the module docstring.
_PROSE_EXEMPT = (Path(".claude") / "skills" / "flare",)

# A stub `gh` that answers nothing and reports every creation it is asked for.
# Anything other than `label create` is silently ignored, so a bootstrap script
# that grew an unrelated `gh` call still runs to completion.
_GH_STUB = (
    "#!/usr/bin/env bash\n"
    'if [ "$1" = "label" ] && [ "$2" = "create" ]; then\n'
    "  printf 'CREATED %s\\n' \"$3\"\n"
    "fi\n"
)
_STUB_MODE = 0o755
_CREATED_PREFIX = "CREATED "

# A literal name handed to `gh label create`. Anchored on a leading letter so
# that a flag (`--force`), a shell variable, or a quoted expression is not
# mistaken for a name.
_GH_LABEL_CREATE = re.compile(r"gh label create\s+([A-Za-z][\w:.-]*)")

# A label passed on a `gh` command line, double-quoted, single-quoted, or bare.
# The `\s` in the separator class is load-bearing rather than decorative: the
# grooming prompt wraps its promotion command across two lines, so the text
# really is `--remove-label\n    needs-triage`, and a separator matching only a
# space would miss the single defect this module was written for.
_LABEL_FLAG = re.compile(r"--(?:add-|remove-)?labels?[=\s]+(?:\"([^\"]*)\"|'([^']*)'|([^\s\"']+))")

# `labels: bug,infra` -- the input the seven callers of the shared failure
# reporter pass it. Anchored on a leading letter so an expression or an input
# declaration with nothing after the colon is not read as a value.
_LABELS_INPUT = re.compile(r"^\s+labels:[ \t]*([A-Za-z][\w:,.-]*)[ \t]*$", re.MULTILINE)

# Punctuation that surrounds a label when it is quoted inside prose. The
# grooming prompt's occurrence ends `needs-triage`).` because the command sits
# inside a parenthesised sentence.
_PROSE_EDGES = "`'\"(),.;:*"


@dataclass(frozen=True)
class LabelUse:
    """One place a label name is handed to a command."""

    label: str
    path: Path
    line: int

    @property
    def where(self) -> str:
        """The location in the form an editor and a reviewer both accept."""
        return f"{self.path}:{self.line}"


def _clean(value: str) -> str:
    """Strip the whitespace and prose punctuation wrapped around a captured value."""
    return value.strip().strip(_PROSE_EDGES)


def _is_a_label(value: str) -> bool:
    """Answer whether a captured value is a label name at all.

    Three things get captured by a pattern looking for the argument of
    ``--label`` and are not labels: a shell variable, whose value is unknowable
    from here; a file path, which the graph workflow passes to ``--labels``
    meaning something else entirely; and a documentation placeholder such as
    ``<priority>``.
    """
    if not value or value.startswith("$"):
        return False
    if "/" in value or "." in value:
        return False
    return "<" not in value and ">" not in value


def _bootstrapped_labels(root: Path) -> set[str]:
    """Return the labels ``root``'s bootstrap script creates, by running it.

    Executed rather than read. The script creates every label through a
    ``label()`` shell helper and produces a dozen of them from a ``for`` loop,
    so a regex over its text would learn the helper's ``"$1"`` and none of the
    names. A missing script yields nothing rather than raising, which keeps the
    throwaway trees below from each needing one; the real tree is held to having
    a script that creates something by its own test.
    """
    script = root / _BOOTSTRAP_SCRIPT
    if not script.is_file():
        return set()
    with tempfile.TemporaryDirectory() as stub_home:
        stub = Path(stub_home) / "gh"
        stub.write_text(_GH_STUB, encoding="utf-8")
        stub.chmod(_STUB_MODE)
        completed = subprocess.run(
            [str(script)],
            capture_output=True,
            text=True,
            check=True,
            cwd=root,
            env={**os.environ, "PATH": f"{stub_home}{os.pathsep}{os.environ['PATH']}"},
        )
    return {
        line.removeprefix(_CREATED_PREFIX)
        for line in completed.stdout.splitlines()
        if line.startswith(_CREATED_PREFIX)
    }


def _workflow_created_labels(root: Path) -> set[str]:
    """Return the labels workflows under ``root`` create for themselves."""
    return {
        match.group(1)
        for _, text in _readable_files(root, (_WORKFLOWS,))
        for match in _GH_LABEL_CREATE.finditer(text)
    }


def _defined_labels(root: Path) -> set[str]:
    """Return every label something inside ``root`` creates."""
    return _bootstrapped_labels(root) | _workflow_created_labels(root)


def _readable_files(root: Path, subdirs: tuple[Path, ...]) -> list[tuple[Path, str]]:
    """Return every readable text file under ``subdirs``, with its contents.

    Paths come back relative to ``root`` so a failure message reads the same
    whether it came from the real repository or from a temporary directory.
    """
    found: list[tuple[Path, str]] = []
    for subdir in subdirs:
        directory = root / subdir
        if not directory.is_dir():
            continue
        for path in sorted(directory.rglob("*")):
            if not path.is_file():
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            found.append((path.relative_to(root), text))
    return found


def _captured_values(pattern: re.Pattern[str], text: str) -> list[tuple[str, int]]:
    """Return each value ``pattern`` captures in ``text``, with its offset."""
    return [
        (next(group for group in match.groups() if group is not None), match.start())
        for match in pattern.finditer(text)
    ]


def _uses_in(text: str, path: Path, *, yaml_inputs: bool) -> list[LabelUse]:
    """Return every label ``text`` hands to a command, one entry per name.

    A comma-separated value is split, because ``--label playbook,P0`` applies
    two labels and either of them can be the wrong one.
    """
    patterns = [_LABEL_FLAG, _LABELS_INPUT] if yaml_inputs else [_LABEL_FLAG]
    return [
        LabelUse(label=name, path=path, line=text.count("\n", 0, offset) + 1)
        for pattern in patterns
        for raw, offset in _captured_values(pattern, text)
        for name in map(_clean, raw.split(","))
        if _is_a_label(name)
    ]


def _applied_labels(root: Path, roots: tuple[Path, ...] = _COMMAND_ROOTS) -> list[LabelUse]:
    """Return every label the executable instructions under ``roots`` apply or filter on."""
    return [
        use
        for subdir in roots
        for path, text in _readable_files(root, (subdir,))
        for use in _uses_in(text, path, yaml_inputs=subdir == _WORKFLOWS)
    ]


def _undefined_label_uses(root: Path, roots: tuple[Path, ...] = _COMMAND_ROOTS) -> list[LabelUse]:
    """Return the label uses under ``root`` that nothing in ``root`` creates."""
    known = _defined_labels(root) | _CREATED_ELSEWHERE
    return [use for use in _applied_labels(root, roots) if use.label not in known]


def _retired_label_mentions(
    root: Path,
    retired: frozenset[str],
    roots: tuple[Path, ...] = _PROSE_ROOTS,
    exempt: tuple[Path, ...] = _PROSE_EXEMPT,
) -> list[str]:
    """Return every ``path:line -- label`` where ``roots`` names a retired label."""
    return [
        f"{path}:{number} names `{label}`"
        for path, text in _readable_files(root, roots)
        if not any(path.is_relative_to(prefix) for prefix in exempt)
        for number, line in enumerate(text.splitlines(), start=1)
        for label in sorted(retired)
        if label in line
    ]


def _undefined_readiness_labels(
    root: Path,
    roots: tuple[Path, ...] = _PROSE_ROOTS,
    exempt: tuple[Path, ...] = _PROSE_EXEMPT,
) -> list[str]:
    """Return every ``needs-*`` token under ``roots`` that nothing in ``root`` creates."""
    known = _defined_labels(root) | _CREATED_ELSEWHERE | _NOT_A_LABEL
    return sorted(
        {
            f"{path}:{number} names `{token}`"
            for path, text in _readable_files(root, roots)
            if not any(path.is_relative_to(prefix) for prefix in exempt)
            for number, line in enumerate(text.splitlines(), start=1)
            for token in _READINESS_FAMILY.findall(line)
            if token not in known
        }
    )


# --- The real tree ---------------------------------------------------------


def test_the_bootstrap_script_declares_a_vocabulary() -> None:
    """Half of `_defined_labels` comes from running it; an empty answer grades nothing."""
    created = _bootstrapped_labels(_REPO_ROOT)

    assert created, "the label bootstrap script created nothing; this guard is inert"


def test_at_least_one_workflow_creates_its_own_label() -> None:
    """The other half. Without a self-bootstrapping workflow that branch is untested."""
    created = _workflow_created_labels(_REPO_ROOT)

    assert created, "no workflow runs `gh label create`; half of this guard is inert"


def test_the_executable_instructions_name_labels_at_all() -> None:
    """An extraction that finds nothing would pass Check A for the wrong reason."""
    applied = _applied_labels(_REPO_ROOT)

    assert applied, "no prompt or workflow applies a label; this guard is inert"


def test_every_label_created_elsewhere_is_one_this_repository_uses() -> None:
    """An allowlist entry nobody reaches is standing permission with no purpose.

    It costs nothing today and quietly licenses the wrong thing later, when a
    name that happens to match is introduced for an unrelated reason.
    """
    assert _CREATED_ELSEWHERE, "an empty allowlist makes the exemption tests vacuous"
    used = {use.label for use in _applied_labels(_REPO_ROOT)}
    unused = sorted(_CREATED_ELSEWHERE - used)

    assert not unused, f"allowlisted but applied by nothing in the tree: {unused}"


def test_every_label_a_command_applies_is_created_by_this_repository() -> None:
    """A command that applies a label nothing creates is a branch that has never worked."""
    undefined = _undefined_label_uses(_REPO_ROOT)
    reported = sorted(f"{use.label} at {use.where}" for use in undefined)

    assert not undefined, (
        f"applied by a prompt or workflow but created by nothing in this repository: {reported}"
    )


def test_a_label_this_repository_never_creates_is_not_named_anywhere() -> None:
    """Prose is instruction too: a name written down is a name somebody will type."""
    mentions = _retired_label_mentions(_REPO_ROOT, _LABELS_THE_REPO_DOES_NOT_DEFINE)

    assert not mentions, (
        "these name a label the repository does not create, so a reader who follows "
        f"them applies nothing: {mentions}"
    )


def test_every_readiness_label_named_anywhere_is_one_this_repository_creates() -> None:
    """The generalisation of the check above, so the next wrong name is caught on arrival.

    `needs-spec` passes this only because the bootstrap script creates it, which
    is the coupling worth keeping: inventing a readiness label and defining it
    become the same edit.
    """
    undefined = _undefined_readiness_labels(_REPO_ROOT)

    assert not undefined, (
        f"readiness labels named but created by nothing in this repository: {undefined}"
    )


def test_the_readiness_family_matches_the_label_this_repository_settled_on() -> None:
    """An inertness guard: a pattern that matched nothing would pass for the wrong reason."""
    known = _defined_labels(_REPO_ROOT)
    family = sorted(label for label in known if _READINESS_FAMILY.fullmatch(label))

    assert family == ["needs-spec"], f"unexpected readiness vocabulary: {family}"


# --- The same checks, pointed at a tree built to fail them -----------------
#
# Everything above passes on a repository where these checks do nothing at all.
# These cases are the proof that they do something.


def _tree(root: Path, files: dict[str, str]) -> Path:
    """Write a throwaway tree from a mapping of relative path to contents."""
    for name, body in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")
    return root


def _workflow(body: str) -> dict[str, str]:
    """One workflow file, at the path the checks look for workflows in."""
    return {str(_WORKFLOWS / "scan.yml"): body}


def test_an_undefined_label_in_a_workflow_is_caught(tmp_path: Path) -> None:
    """The plain case: a command applies a name nothing in the tree ever creates."""
    _tree(tmp_path, _workflow('      - run: gh issue edit 1 --add-label "invented"\n'))

    undefined = _undefined_label_uses(tmp_path)

    assert [use.label for use in undefined] == ["invented"]
    assert undefined[0].where.endswith("scan.yml:1")


def test_the_same_workflow_is_accepted_once_something_creates_the_label(tmp_path: Path) -> None:
    """The control. A rule that rejects the fixed version too is just a ban on labels."""
    _tree(
        tmp_path,
        _workflow(
            "      - run: gh label create invented --color FFFFFF\n"
            '      - run: gh issue edit 1 --add-label "invented"\n'
        ),
    )

    assert _undefined_label_uses(tmp_path) == []


def test_a_flag_wrapped_onto_the_next_line_is_caught(tmp_path: Path) -> None:
    """The exact shape of the real defect, and the one a space-only separator misses.

    The grooming prompt's promotion command runs past the line width and wraps,
    so the label sits on the line after its flag. An extraction that required a
    space between the two would report a clean tree and the defect would survive
    the guard written to catch it.
    """
    _tree(
        tmp_path,
        {
            str(_PROMPTS / "groom.md"): (
                "Promote it (`gh issue edit --add-label agent-ready --remove-label\n"
                "wrapped-name`).\n"
            )
        },
    )

    undefined = _undefined_label_uses(tmp_path)

    assert sorted(use.label for use in undefined) == ["agent-ready", "wrapped-name"]


def test_a_shell_variable_is_not_read_as_a_label(tmp_path: Path) -> None:
    """The reporter passes a variable; its value is decided by the caller, not readable here."""
    _tree(tmp_path, _workflow('      - run: gh issue edit 1 --add-label "$LABEL"\n'))

    assert _undefined_label_uses(tmp_path) == []


def test_a_path_argument_is_not_read_as_a_label(tmp_path: Path) -> None:
    """One workflow passes `--labels` a JSON file, meaning something else by the same flag."""
    _tree(tmp_path, _workflow("      - run: graphify --labels out/.graphify_labels.json\n"))

    assert _undefined_label_uses(tmp_path) == []


def test_a_documentation_placeholder_is_not_read_as_a_label(tmp_path: Path) -> None:
    """`<priority>` is an instruction to substitute, not a name to look up."""
    _tree(tmp_path, {str(_PROMPTS / "file.md"): "Run `gh issue edit --add-label <priority>`.\n"})

    assert _undefined_label_uses(tmp_path) == []


def test_a_comma_separated_value_flags_only_its_undefined_member(tmp_path: Path) -> None:
    """Two labels in one argument, one of them wrong; naming the whole string helps nobody."""
    _tree(
        tmp_path,
        _workflow(
            "      - run: gh label create defined --color FFFFFF\n"
            "      - run: gh issue create --label defined,undefined\n"
        ),
    )

    assert [use.label for use in _undefined_label_uses(tmp_path)] == ["undefined"]


def test_a_reusable_workflow_input_is_read_as_labels(tmp_path: Path) -> None:
    """The failure reporter's callers pass their labels as a YAML input, not as a flag.

    Seven workflows reach the shared reporter this way, so an extraction blind
    to this shape would leave every label they apply ungraded.
    """
    _tree(
        tmp_path,
        _workflow(
            "  report-failure:\n"
            "    uses: ./.github/workflows/_report-failure.yml\n"
            "    with:\n"
            "      labels: bug,by-input-only\n"
        ),
    )

    assert [use.label for use in _undefined_label_uses(tmp_path)] == ["by-input-only"]


def test_a_labels_input_with_nothing_after_it_yields_no_label(tmp_path: Path) -> None:
    """The reporter itself declares the input; the declaration is not a use of it."""
    _tree(
        tmp_path,
        _workflow(
            "on:\n"
            "  workflow_call:\n"
            "    inputs:\n"
            "      labels:\n"
            "        description: Comma-separated labels\n"
            "        type: string\n"
        ),
    )

    assert _applied_labels(tmp_path) == []


def test_a_retired_label_named_in_prose_is_caught(tmp_path: Path) -> None:
    """Check B grades the name, not the command; prose is where the wrong name spreads."""
    _tree(
        tmp_path,
        {str(_SKILLS / "writer" / "SKILL.md"): "Line one.\nFile it as retired-name for now.\n"},
    )

    mentions = _retired_label_mentions(tmp_path, frozenset({"retired-name"}))

    assert mentions == [f"{_SKILLS / 'writer' / 'SKILL.md'}:2 names `retired-name`"]


def test_an_exempt_path_may_still_name_the_retired_label(tmp_path: Path) -> None:
    """The record that documents the trap is the reason the trap is known; it stays."""
    guide = _SKILLS / "flare" / "references" / "label-guide.md"
    _tree(tmp_path, {str(guide): "Apply needs-spec, never retired-name.\n"})

    assert _retired_label_mentions(tmp_path, frozenset({"retired-name"})) == []


def test_a_looped_bootstrap_script_yields_every_name_it_loops_over(tmp_path: Path) -> None:
    """Proves the script is run rather than read, which is the whole reason it is run.

    This fixture mirrors the real script's shape: a helper that forwards its
    first argument, and a loop that calls the helper once per name. A regex
    would answer with the helper's `"$1"` and nothing else.
    """
    script = tmp_path / _BOOTSTRAP_SCRIPT
    script.parent.mkdir(parents=True, exist_ok=True)
    script.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        'label() { gh label create "$1" --color FFFFFF --force; }\n'
        "for scan in alpha beta gamma; do\n"
        '  label "scan:${scan}"\n'
        "done\n"
        'label "standalone"\n',
        encoding="utf-8",
    )
    script.chmod(_STUB_MODE)

    assert _bootstrapped_labels(tmp_path) == {
        "scan:alpha",
        "scan:beta",
        "scan:gamma",
        "standalone",
    }


def test_a_tree_with_no_bootstrap_script_defines_nothing_that_way(tmp_path: Path) -> None:
    """Absence is tolerated so the fixtures above stay small, and asserted against above."""
    assert _bootstrapped_labels(tmp_path) == set()


def test_an_invented_readiness_label_is_caught(tmp_path: Path) -> None:
    """A name from the family that nothing creates, which is the defect generalised."""
    _tree(tmp_path, {str(_PROMPTS / "p.md"): "Label it needs-review until somebody looks.\n"})

    assert _undefined_readiness_labels(tmp_path) == [f"{_PROMPTS / 'p.md'}:1 names `needs-review`"]


def test_a_readiness_label_the_bootstrap_creates_is_accepted(tmp_path: Path) -> None:
    """The control, and the reason the fix had to touch the bootstrap script."""
    script = tmp_path / _BOOTSTRAP_SCRIPT
    script.parent.mkdir(parents=True, exist_ok=True)
    script.write_text(
        '#!/usr/bin/env bash\nset -euo pipefail\ngh label create "needs-review" --force\n',
        encoding="utf-8",
    )
    script.chmod(_STUB_MODE)
    _tree(tmp_path, {str(_PROMPTS / "p.md"): "Label it needs-review until somebody looks.\n"})

    assert _undefined_readiness_labels(tmp_path) == []


def test_the_audit_verdict_token_is_not_read_as_a_readiness_label(tmp_path: Path) -> None:
    """It sits in a list of report verdicts beside `fine` and `edited`, not in a label set."""
    _tree(tmp_path, {str(_PROMPTS / "a.md"): "verdict (`fine` / `edited` / `needs-owner`)\n"})

    assert _undefined_readiness_labels(tmp_path) == []
