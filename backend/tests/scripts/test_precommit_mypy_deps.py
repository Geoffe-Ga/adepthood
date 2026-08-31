"""The mypy hook must not restate a version that a requirements file pins.

The ``mypy`` pre-commit hook used to be a cloned ``mirrors-mypy`` hook whose
``additional_dependencies`` hand-listed 22 backend pins -- ``openai==...``,
``cryptography==...``, ``sentry-sdk==...`` and so on -- every one of which was
*also* pinned in ``backend/requirements.txt``.  Dependabot edits the
requirements file and knows nothing about the hook, so the two lists diverged on
every backend dependency bump.  The divergence is not cosmetic: mypy then
type-checks the application against a library version the application does not
install, and the resulting error lands on a line nobody touched.

A value stated in two places is a value that eventually disagrees with itself.
The previous guard detected the disagreement after the fact; it could not stop
it, because Dependabot cannot regenerate a hand-written list.  So the second
list is gone.  The hook now runs ``language: system``, meaning pre-commit builds
no environment of its own and invokes the ``mypy`` already installed from
``backend/requirements-dev.txt`` -- against the runtime libraries already
installed from ``backend/requirements.txt``.  The requirements files are the
single source of truth, and there is nothing left to keep in step by hand.

This module locks that shape in.  Four invariants:

* the mypy hook carries no ``additional_dependencies`` at all, so the duplicate
  list cannot come back;
* the hook is ``language: system``, so it cannot quietly start building a
  private environment that drifts from the installed one;
* ``requirements-dev.txt`` pins mypy with ``==``, so the version the hook runs
  is reproducible rather than "whatever PyPI served that day"; and
* the mypy actually installed *is* that pinned version, which is what makes the
  three invariants above describe reality instead of an intention.

That last one is the non-vacuity check that matters.  The first three inspect a
config file and would pass just as happily if the seam were decorative; only
comparing the pin against the interpreter's own installed distribution proves
the requirements file really governs the type checker.

The YAML is parsed as text on purpose.  PyYAML is deliberately absent from every
requirements file in this repo, so ``import yaml`` would turn this guard into a
collection error on the ``backend-compat`` job rather than a passing check.
``test_dependabot_ignores.py`` and ``test_precommit_staged_file_gating.py``
guard their configs the same way, for the same reason.
"""

from __future__ import annotations

import pathlib
import re
from importlib import metadata

BACKEND_DIR = pathlib.Path(__file__).resolve().parents[2]
REPO_ROOT = BACKEND_DIR.parent
PRECOMMIT_CONFIG = REPO_ROOT / ".pre-commit-config.yaml"
REQUIREMENTS_DEV = BACKEND_DIR / "requirements-dev.txt"

# The mypy hook's block: from its ``- id: mypy`` line to the next ``- id:`` or
# ``- repo:``, which are the only two things that can end it.
_MYPY_BLOCK = re.compile(
    r"^[ \t]*- id:[ \t]*mypy[ \t]*$\n(?P<body>(?:(?![ \t]*- (?:id|repo):).*\n)*)",
    re.MULTILINE,
)
_ADDITIONAL_DEPENDENCIES = re.compile(
    r"^[ \t]*additional_dependencies:[ \t]*(?P<value>.*)$",
    re.MULTILINE,
)
_QUOTED = re.compile(r'"([^"]+)"')
_LANGUAGE = re.compile(r"^[ \t]*language:[ \t]*(?P<value>\S+)[ \t]*$", re.MULTILINE)
_ENTRY = re.compile(r"^[ \t]*entry:[ \t]*(?P<value>[^\n#]+?)[ \t]*$", re.MULTILINE)


def mypy_hook_block(config: str) -> str | None:
    """Return the text of the mypy hook's own YAML block.

    Args:
        config: The whole ``.pre-commit-config.yaml`` as text.

    Returns:
        The hook's body, or None when no ``- id: mypy`` hook is declared.
    """
    match = _MYPY_BLOCK.search(config)
    return match.group("body") if match else None


def hand_maintained_pins(block: str) -> list[str]:
    """Return every version this hook block restates in its own dependency list.

    Args:
        block: One hook's YAML block.

    Returns:
        The quoted ``additional_dependencies`` entries, empty when the hook
        declares no dependency list of its own.
    """
    match = _ADDITIONAL_DEPENDENCIES.search(block)
    return _QUOTED.findall(match.group("value")) if match else []


def hook_language(block: str) -> str | None:
    """Return the hook's declared ``language``.

    Args:
        block: One hook's YAML block.

    Returns:
        The language name, or None when the block declares none.
    """
    match = _LANGUAGE.search(block)
    return match.group("value") if match else None


def hook_entry(block: str) -> str | None:
    """Return the hook's declared ``entry``.

    Args:
        block: One hook's YAML block.

    Returns:
        The entry command, or None when the block declares none.
    """
    match = _ENTRY.search(block)
    return match.group("value") if match else None


def pinned_version(requirements: str, package: str) -> str | None:
    """Return the ``==`` pin a requirements file states for one package.

    Args:
        requirements: The requirements file as text.
        package: The distribution name to look up.

    Returns:
        The pinned version, or None when the package is absent or unpinned.
    """
    pattern = rf"^{re.escape(package)}==(?P<version>[^\s;#]+)"
    match = re.search(pattern, requirements, re.MULTILINE)
    return match.group("version") if match else None


def _committed_mypy_block() -> str:
    """Return the committed config's mypy hook block.

    Returns:
        The hook's body text.
    """
    block = mypy_hook_block(PRECOMMIT_CONFIG.read_text(encoding="utf-8"))
    assert block is not None, (
        "no '- id: mypy' hook found in .pre-commit-config.yaml; this guard is "
        "matching nothing and every assertion below is vacuous."
    )
    return block


def test_the_guard_locates_the_mypy_hook() -> None:
    """A regex that silently matched nothing would make the module vacuous."""
    block = _committed_mypy_block()
    assert hook_entry(block) is not None, f"parsed no entry from the mypy block: {block!r}"


def test_the_mypy_hook_restates_no_pin_the_requirements_files_own() -> None:
    """The 22-pin duplicate list is the drift; there must be no list at all."""
    restated = hand_maintained_pins(_committed_mypy_block())
    assert not restated, (
        "the mypy hook hand-maintains its own dependency pins again: "
        f"{restated}. Every one of these is already pinned in "
        "backend/requirements*.txt, and Dependabot updates only the "
        "requirements file -- so the two lists will diverge on the next bump. "
        "Let the hook run from the installed environment instead."
    )


def test_the_mypy_hook_runs_from_the_installed_environment() -> None:
    """``language: system`` is what makes the requirements files authoritative."""
    language = hook_language(_committed_mypy_block())
    assert language == "system", (
        f"the mypy hook declares language: {language}. Any language other than "
        "'system' makes pre-commit build a private environment, which is the "
        "second dependency list this guard exists to prevent."
    )


def test_requirements_dev_pins_the_mypy_the_hook_will_run() -> None:
    """An unpinned mypy resolves to whatever PyPI serves when the cache is cold."""
    pin = pinned_version(REQUIREMENTS_DEV.read_text(encoding="utf-8"), "mypy")
    assert pin is not None, (
        "backend/requirements-dev.txt does not pin mypy with '=='. The system "
        "hook runs whatever mypy is installed, so that pin is the only thing "
        "making the type-check environment reproducible."
    )


def test_the_installed_mypy_is_the_one_requirements_dev_pins() -> None:
    """The seam must be live: the pin has to govern the actual interpreter.

    The three assertions above read a config file and would pass unchanged if
    the requirements file governed nothing at all. This one fails when the
    installed mypy and the pin disagree, which is the condition that would make
    the local hook and CI reach different verdicts.
    """
    pin = pinned_version(REQUIREMENTS_DEV.read_text(encoding="utf-8"), "mypy")
    assert metadata.version("mypy") == pin, (
        f"installed mypy is {metadata.version('mypy')} but "
        f"backend/requirements-dev.txt pins {pin}. The system hook runs the "
        "installed one, so this environment's type-check verdict does not "
        "predict CI's. Reinstall from the pinned requirements."
    )


# --- the alarm itself ---------------------------------------------------------
# Everything above runs against the committed config, which is correct today, so
# all of it passes whether or not the detection works at all. These drive
# fabricated inputs instead: a detector that has never been shown to fire is
# exactly the shape of guard this repo keeps finding -- green, and proving
# nothing.

_DUPLICATED_LIST_CONFIG = """repos:
  - repo: https://github.com/pre-commit/mirrors-mypy
    rev: v1.17.1
    hooks:
      - id: mypy
        files: ^backend/
        args: ["--config-file=backend/pyproject.toml"]
        additional_dependencies: ["openai==3.3.0", "anthropic==0.123.0"]

  - repo: https://github.com/PyCQA/isort
    rev: 6.0.1
    hooks:
      - id: isort
        additional_dependencies: ["not-the-mypy-hook==1.0.0"]
"""

_SINGLE_SOURCE_CONFIG = """repos:
  - repo: local
    hooks:
      - id: mypy
        name: mypy
        entry: mypy
        language: system
        files: ^backend/
        args: ["--config-file=backend/pyproject.toml"]

  - repo: https://github.com/PyCQA/isort
    rev: 6.0.1
    hooks:
      - id: isort
        additional_dependencies: ["not-the-mypy-hook==1.0.0"]
"""


def test_alarm_fires_on_a_reintroduced_dependency_list() -> None:
    """The exact shape that broke three Dependabot pull requests."""
    block = mypy_hook_block(_DUPLICATED_LIST_CONFIG)
    assert block is not None
    assert hand_maintained_pins(block) == ["openai==3.3.0", "anthropic==0.123.0"]


def test_alarm_fires_when_the_hook_builds_its_own_environment() -> None:
    """A cloned hook installs its own mypy, which is the drift by another name."""
    block = mypy_hook_block(_DUPLICATED_LIST_CONFIG)
    assert block is not None
    assert hook_language(block) != "system"


def test_alarm_stays_silent_on_the_shape_the_repository_ships() -> None:
    """A correct config must not be reported, or the guard cries wolf."""
    block = mypy_hook_block(_SINGLE_SOURCE_CONFIG)
    assert block is not None
    assert hand_maintained_pins(block) == []
    assert hook_language(block) == "system"
    assert hook_entry(block) == "mypy"


def test_the_block_stops_at_the_next_hook() -> None:
    """Bleeding into a neighbour would let another hook's list mask the mypy one."""
    block = mypy_hook_block(_SINGLE_SOURCE_CONFIG)
    assert block is not None
    assert "isort" not in block
    assert "not-the-mypy-hook" not in block


def test_an_absent_mypy_hook_is_reported_rather_than_passing_silently() -> None:
    """Deleting the hook must break this guard, not satisfy it."""
    assert mypy_hook_block("repos:\n  - repo: local\n    hooks:\n      - id: ruff\n") is None


def test_pinned_version_reads_only_an_exact_pin() -> None:
    """A floor or a range is not a pin, and must not be mistaken for one."""
    assert pinned_version("mypy==2.3.1\n", "mypy") == "2.3.1"
    assert pinned_version("mypy>=2.3.1\n", "mypy") is None
    assert pinned_version("# mypy==2.3.1\n", "mypy") is None
    assert pinned_version("pytest==9.1.1\n", "mypy") is None
