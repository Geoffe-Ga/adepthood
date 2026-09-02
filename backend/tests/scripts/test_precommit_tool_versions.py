"""No cloned pre-commit hook may restate a version the requirements files pin.

Three cloned hooks -- ruff, isort and bandit -- each carried a ``rev:`` naming a
tool version while ``backend/requirements*.txt`` pinned a *different* version of
the same tool with ``==``.  Two declarations of one number, and nothing in this
repository reconciles them: there is no ``package-ecosystem: "pre-commit"``
entry in ``.github/dependabot.yml`` and no ``autoupdate`` anywhere, so Dependabot
ratchets the requirements pins forward while every ``rev:`` stays frozen at the
value it was first committed with.

The consequence is two tools both presenting themselves as one gate.
``backend-ci.yml`` installs the requirements files and then runs ``pre-commit``,
which ignores them and clones its own linter from ``rev:``; ``check-all.sh``
runs the installed one.  Neither verdict predicts the other, and no message says
which tool spoke.

The invariant asserted here is ABSENCE, not equality.  An equality assertion
would go green by hand-editing ``rev:`` to match today's pin -- leaving the
two-place shape intact and re-opening on the next Dependabot bump, with no bot
able to move the other side.  That is the failure this repository already paid
for once with the mypy hook's ``additional_dependencies`` list, which a detector
could report but never repair.  Emptiness is satisfiable exactly one way: delete
the second declaration and let the hook run the installed tool through
``language: system``.

Two things this guard deliberately does *not* do.  It does not strip a
``-hooks`` suffix from a repository slug, because ``pre-commit-hooks`` would
then resolve to ``pre-commit`` -- which *is* pinned -- and it would report an
offender that does not exist.  And it does not cover the
``additional_dependencies`` shape of the same defect; that one is guarded by
``test_precommit_mypy_deps.py``.

The YAML is parsed as text on purpose.  PyYAML is deliberately absent from every
requirements file in this repo -- see the header of
``backend/requirements-dast.txt`` -- so ``import yaml`` would turn this guard
into a collection error on the ``backend-compat`` job rather than a passing
check.  ``test_precommit_mypy_deps.py`` and ``test_dependabot_ignores.py`` read
their configs the same way, for the same reason.

The requirement *pins* are read through ``scripts.check_dependency_drift``
rather than through a fourth hand-rolled regex, so this guard and the drift
preflight can never disagree about what counts as a pin.
"""

from __future__ import annotations

import pathlib
import re
from dataclasses import dataclass
from importlib import metadata
from typing import TYPE_CHECKING

import pytest

from scripts.check_dependency_drift import (
    PinnedRequirement,
    iter_requirement_lines,
    normalize_name,
    parse_pin,
)

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping

BACKEND_DIR = pathlib.Path(__file__).resolve().parents[2]
REPO_ROOT = BACKEND_DIR.parent
PRECOMMIT_CONFIG = REPO_ROOT / ".pre-commit-config.yaml"

# Every requirements file the backend owns.  A pin in any one of them is a
# second declaration of the same number, and the lock file alone holds click,
# attrs, packaging and pygments -- all of which ship pre-commit hooks upstream.
REQUIREMENTS_FILES = (
    BACKEND_DIR / "requirements.txt",
    BACKEND_DIR / "requirements-dev.txt",
    BACKEND_DIR / "requirements-lock.txt",
    BACKEND_DIR / "requirements-dast.txt",
)

# Tools whose hooks now run from the installed environment, so the requirements
# pin is the only version anything executes.
SYSTEM_TOOLS = ("ruff", "bandit")

_REPO_LINE = re.compile(r"^[ \t]*- repo:[ \t]*(?P<source>\S+)[ \t]*$", re.MULTILINE)
_REV_LINE = re.compile(r"^[ \t]*rev:[ \t]*(?P<value>\S+)[ \t]*$", re.MULTILINE)
_HOOK_ID_LINE = re.compile(r"^[ \t]*- id:[ \t]*(?P<value>\S+)[ \t]*$", re.MULTILINE)

_LOCAL_REPO = "local"
_PRE_COMMIT_SUFFIX = "-pre-commit"
_MIRRORS_PREFIX = "mirrors-"
_GIT_SUFFIX = ".git"

_FIXTURE_VERSION = "9.9.9"


@dataclass(frozen=True)
class ClonedRepo:
    """One ``- repo:`` section that pre-commit clones and builds for itself.

    Attributes:
        source: The repository URL as spelled in the config.
        rev: The revision the config pins that clone to.
        candidates: PEP 503 normalised names of every distribution the section
            could plausibly install, derived from the URL slug and from each
            hook id declared inside it.
    """

    source: str
    rev: str
    candidates: frozenset[str]


@dataclass(frozen=True)
class Restatement:
    """A cloned hook's tool version that a requirements file also pins.

    Attributes:
        repo: The cloned section carrying the ``rev:``.
        distribution: The normalised distribution name both sides name.
        pin: The requirements-file pin for that distribution.
    """

    repo: ClonedRepo
    distribution: str
    pin: PinnedRequirement


def repo_slug(source: str) -> str:
    """Return the distribution-bearing last segment of a repository URL.

    Args:
        source: A ``- repo:`` value, typically a GitHub URL.

    Returns:
        The final path segment, with any trailing ``.git`` removed.
    """
    return source.rstrip("/").rsplit("/", 1)[-1].removesuffix(_GIT_SUFFIX)


def candidate_distributions(source: str, hook_ids: Iterable[str]) -> frozenset[str]:
    """Return every distribution name a cloned section could be installing.

    The slug is the primary signal -- ``PyCQA/bandit`` installs ``bandit`` --
    but upstream mirrors rename it: ``astral-sh/ruff-pre-commit`` installs
    ``ruff`` and ``pre-commit/mirrors-mypy`` installs ``mypy``.  Hook ids are
    folded in because a section can install a tool its URL never names.

    A ``-hooks`` suffix is deliberately not stripped.  ``pre-commit-hooks``
    would otherwise resolve to ``pre-commit``, which is itself pinned, and the
    guard would invent an offender.

    Args:
        source: The ``- repo:`` URL.
        hook_ids: Every ``- id:`` declared inside that section.

    Returns:
        The PEP 503 normalised candidate names.
    """
    slug = repo_slug(source)
    names = {slug, slug.removesuffix(_PRE_COMMIT_SUFFIX), slug.removeprefix(_MIRRORS_PREFIX)}
    names.update(hook_ids)
    return frozenset(normalize_name(name) for name in names if name)


def cloned_repos(config: str) -> tuple[ClonedRepo, ...]:
    """Return every ``- repo:`` section pre-commit clones rather than reuses.

    Args:
        config: The whole ``.pre-commit-config.yaml`` as text.

    Returns:
        One entry per section carrying a ``rev:``, in config order.
        ``- repo: local`` sections have no ``rev:`` and run the installed tool,
        so they are excluded -- they are the shape this guard steers towards.
    """
    matches = list(_REPO_LINE.finditer(config))
    repos: list[ClonedRepo] = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(config)
        section = config[match.start() : end]
        revision = _REV_LINE.search(section)
        if revision is None:
            continue
        source = match.group("source")
        repos.append(
            ClonedRepo(
                source=source,
                rev=revision.group("value"),
                candidates=candidate_distributions(source, _HOOK_ID_LINE.findall(section)),
            ),
        )
    return tuple(repos)


def pinned_distributions(paths: Iterable[pathlib.Path]) -> dict[str, PinnedRequirement]:
    """Return every exact ``==`` pin across the given requirements files.

    Args:
        paths: Requirements files to read.

    Returns:
        A mapping of PEP 503 normalised distribution name to the first pin
        found for it.  Lines that are not exact pins -- includes, ranges,
        environment-marked requirements -- are skipped, exactly as the drift
        preflight skips them.
    """
    pins: dict[str, PinnedRequirement] = {}
    for path in paths:
        for number, text in iter_requirement_lines(path):
            parsed = parse_pin(path, number, text)
            if isinstance(parsed, PinnedRequirement):
                pins.setdefault(parsed.name, parsed)
    return pins


def restatements(
    config: str,
    pins: Mapping[str, PinnedRequirement],
) -> tuple[Restatement, ...]:
    """Return every cloned hook whose tool a requirements file also pins.

    Args:
        config: The whole ``.pre-commit-config.yaml`` as text.
        pins: Distribution pins, shaped like :func:`pinned_distributions`'
            return value.

    Returns:
        One entry per (section, distribution) collision, in config order.
    """
    pinned = set(pins)
    return tuple(
        Restatement(repo=repo, distribution=distribution, pin=pins[distribution])
        for repo in cloned_repos(config)
        for distribution in sorted(repo.candidates & pinned)
    )


def describe(found: Iterable[Restatement]) -> str:
    """Render restatements as the message the guard fails with.

    Args:
        found: The collisions to describe.

    Returns:
        One indented line per collision, naming both declarations.
    """
    return "\n".join(
        f"  {item.repo.source}  rev={item.repo.rev}  also pins "
        f"{item.distribution}=={item.pin.version} "
        f"(backend/{item.pin.source.name}:{item.pin.line_number})"
        for item in found
    )


def _committed_config() -> str:
    """Return the committed pre-commit config as text.

    Returns:
        The contents of ``.pre-commit-config.yaml``.
    """
    return PRECOMMIT_CONFIG.read_text(encoding="utf-8")


def _committed_pins() -> dict[str, PinnedRequirement]:
    """Return every pin the backend requirements files declare.

    Returns:
        A mapping of normalised distribution name to its pin.
    """
    return pinned_distributions(REQUIREMENTS_FILES)


def _fabricated_pins(*names: str) -> dict[str, PinnedRequirement]:
    """Return a pins mapping for the named distributions, for fixture tests.

    Args:
        names: Distribution names to treat as pinned.

    Returns:
        A mapping shaped like :func:`pinned_distributions`' return value, at a
        stand-in version that no real requirements file states.
    """
    return {
        normalize_name(name): PinnedRequirement(
            name=normalize_name(name),
            version=_FIXTURE_VERSION,
            source=pathlib.Path("requirements-dev.txt"),
            line_number=1,
        )
        for name in names
    }


def test_no_cloned_hook_restates_a_version_the_requirements_already_pin() -> None:
    """A tool is cloned by pre-commit or pinned by requirements -- never both."""
    found = restatements(_committed_config(), _committed_pins())
    assert not found, (
        f"{len(found)} cloned hook(s) restate a version "
        f"backend/requirements*.txt already pins:\n{describe(found)}\n"
        "Nothing in this repository moves `rev:` -- there is no pre-commit "
        "ecosystem in .github/dependabot.yml and no autoupdate -- so these "
        "only diverge further. Run the tool from the installed environment "
        "(`language: system`), as the mypy hook does."
    )


def _declared_cloned_sources(config: str) -> list[str]:
    """Return every non-local ``- repo:`` value the config declares.

    Args:
        config: The whole ``.pre-commit-config.yaml`` as text.

    Returns:
        The repository URLs, in config order.
    """
    return [source for source in _REPO_LINE.findall(config) if source != _LOCAL_REPO]


def test_the_guard_examines_every_cloned_repo_in_the_committed_config() -> None:
    """A regex that silently matched a subset would leave versions unguarded."""
    config = _committed_config()
    parsed = [repo.source for repo in cloned_repos(config)]
    assert parsed == _declared_cloned_sources(config), (
        f"the guard parsed {parsed}, which is not the set of non-local repos "
        "the config declares. One skipped section is one unguarded version."
    )


def test_the_committed_config_still_declares_cloned_repos_to_examine() -> None:
    """An empty match set must fail loudly, not pass by comparing nothing."""
    assert _declared_cloned_sources(_committed_config()), (
        "no cloned repo sections were found in .pre-commit-config.yaml, so "
        "the equality assertion above compares two empty lists and proves "
        "nothing. Either every hook is local now -- delete this guard -- or "
        "the parser has stopped matching."
    )


def test_the_pin_side_of_the_comparison_is_not_empty() -> None:
    """An unreadable requirements file would make every intersection empty."""
    pins = _committed_pins()
    assert normalize_name("pytest") in pins, (
        f"parsed {len(pins)} pins from the backend requirements files and "
        "pytest was not among them, so the requirements side of this guard is "
        "not being read at all."
    )


# --- the alarm itself ---------------------------------------------------------
# Everything above runs against the committed config, which is correct once this
# change lands, so all of it passes whether or not the detection works. These
# drive fabricated inputs instead: a detector that has never been shown to fire
# is exactly the shape of guard this repository keeps finding -- green, and
# proving nothing.

_DRIFTED_CONFIG = """repos:
  - repo: https://github.com/astral-sh/ruff-pre-commit
    rev: v0.12.9
    hooks:
      - id: ruff
        files: ^backend/
      - id: ruff-format
        files: ^backend/

  - repo: local
    hooks:
      - id: mypy
        name: mypy
        entry: mypy
        language: system
"""

_SINGLE_SOURCE_CONFIG = """repos:
  - repo: local
    hooks:
      - id: ruff
        name: ruff
        entry: ruff check --force-exclude
        language: system
      - id: ruff-format
        name: ruff-format
        entry: ruff format --force-exclude
        language: system
"""

_NEAR_MISS_CONFIG = """repos:
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v6.0.0
    hooks:
      - id: check-ast
      - id: trailing-whitespace
"""


def test_alarm_fires_on_a_cloned_tool_the_requirements_pin() -> None:
    """The exact shape three hooks shipped: a rev beside a == pin for one tool."""
    found = restatements(_DRIFTED_CONFIG, _fabricated_pins("ruff"))
    assert [item.distribution for item in found] == ["ruff"]
    assert found[0].repo.rev == "v0.12.9"
    assert found[0].repo.source.endswith("ruff-pre-commit")


def test_alarm_stays_silent_on_a_language_system_hook() -> None:
    """A local hook has no rev to disagree with, so it must never be reported."""
    assert restatements(_SINGLE_SOURCE_CONFIG, _fabricated_pins("ruff", "bandit")) == ()


def test_pre_commit_hooks_is_not_mistaken_for_pre_commit() -> None:
    """``pre-commit`` is itself pinned; a -hooks-stripping match invents an offender."""
    assert restatements(_NEAR_MISS_CONFIG, _fabricated_pins("pre-commit")) == ()


def test_a_mirrors_repo_resolves_to_the_tool_it_mirrors() -> None:
    """The shape the mypy hook used to have, so its return would be caught."""
    candidates = candidate_distributions("https://github.com/pre-commit/mirrors-mypy", ())
    assert "mypy" in candidates


def test_a_trailing_git_suffix_does_not_hide_a_restatement() -> None:
    """A ``.git`` URL names the same distribution as the bare one."""
    assert "bandit" in candidate_distributions("https://github.com/PyCQA/bandit.git", ())


def test_a_section_is_bounded_by_the_next_repo() -> None:
    """Bleeding into a neighbour would attribute one section's ids to another."""
    repos = cloned_repos(_DRIFTED_CONFIG)
    assert len(repos) == 1
    assert "mypy" not in repos[0].candidates


@pytest.mark.parametrize("tool", SYSTEM_TOOLS)
def test_the_installed_tool_is_the_one_the_requirements_pin(tool: str) -> None:
    """The seam must be live: the pin has to govern the actual environment.

    Every assertion above reads config files and would pass unchanged if the
    requirements files governed nothing at all. This one fails when the
    installed tool and its pin disagree, which is the condition that makes the
    local hook and CI reach different verdicts.

    Args:
        tool: A distribution whose hook runs ``language: system``.
    """
    pin = _committed_pins().get(normalize_name(tool))
    assert pin is not None, (
        f"backend/requirements*.txt does not pin {tool} with '=='. Its hook "
        "runs whatever is installed, so that pin is the only thing making the "
        "gate reproducible."
    )
    installed = metadata.version(tool)
    assert installed == pin.version, (
        f"installed {tool} is {installed} but backend/{pin.source.name} pins "
        f"{pin.version}. The system hook runs the installed one, so this "
        "environment's verdict does not predict CI's. Reinstall from the "
        "pinned requirements."
    )
