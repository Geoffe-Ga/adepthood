"""Guards the mypy hook's ``additional_dependencies`` against version drift.

The ``mypy`` pre-commit hook type-checks the backend inside its *own* isolated
environment, built from the ``additional_dependencies`` list rather than from
``requirements.txt``.  Whatever is unpinned there resolves to the latest release
on PyPI at the moment the hook environment is built -- which is not when a
developer runs it, but whenever the cache happens to be cold.  CI always builds
cold.

So an unpinned entry means the type checker and the shipped application quietly
disagree about which library they are describing, and the disagreement surfaces
as a type error in code nobody touched, on a machine nobody can reproduce.

That is not hypothetical.  ``openai`` sat unpinned while the backend shipped
``openai==2.53.0``; ``openai`` 3.x re-typed its client against ``httpx2``
instead of ``httpx``, so ``APIConnectionError(request=httpx.Request(...))`` --
correct for the version actually installed -- began failing type-checking with
``incompatible type "httpx._models.Request"; expected "httpx2._models.Request"``.
Every backend pull request went red at once, on a line none of them changed.

Two invariants below close that gap:

* every ``additional_dependencies`` entry is pinned with ``==``, so the
  hook environment is reproducible; and
* when the backend also pins that package, the two pins agree -- so mypy checks
  the code against the library the application actually ships.

The YAML is parsed as text on purpose: PyYAML is deliberately absent from every
requirements file in this repo, and adding a parser dependency to guard a config
file would be a poor trade.  ``test_dependabot_ignores.py`` guards its config
the same way, for the same reason.
"""

from __future__ import annotations

import pathlib
import re

BACKEND_DIR = pathlib.Path(__file__).resolve().parent.parent
REPO_ROOT = BACKEND_DIR.parent
PRECOMMIT_CONFIG = REPO_ROOT / ".pre-commit-config.yaml"
REQUIREMENTS_FILES = (
    BACKEND_DIR / "requirements.txt",
    BACKEND_DIR / "requirements-dev.txt",
    BACKEND_DIR / "requirements-lock.txt",
)

_MYPY_DEPS = re.compile(
    r"^\s*- id: mypy\n(?:.*\n)*?\s*additional_dependencies:\s*\[(?P<deps>[^\]]*)\]",
    re.MULTILINE,
)
_QUOTED = re.compile(r'"([^"]+)"')
_REQUIREMENT = re.compile(r"^(?P<name>[A-Za-z0-9._-]+)==(?P<version>[^\s;#]+)", re.MULTILINE)


def _canonical(name: str) -> str:
    """Normalize a distribution name to its PEP 503 canonical form."""
    return re.sub(r"[-_.]+", "-", name).lower()


def _hook_pins() -> dict[str, str | None]:
    """Map each mypy ``additional_dependencies`` entry to its pinned version.

    A value of ``None`` marks an entry with no ``==`` pin at all.
    """
    match = _MYPY_DEPS.search(PRECOMMIT_CONFIG.read_text(encoding="utf-8"))
    assert match is not None, "could not locate the mypy hook's additional_dependencies"
    pins: dict[str, str | None] = {}
    for entry in _QUOTED.findall(match.group("deps")):
        name, sep, version = entry.partition("==")
        pins[_canonical(name)] = version if sep else None
    return pins


def _backend_pins() -> dict[str, str]:
    """Map every ``==``-pinned backend requirement to its version."""
    pins: dict[str, str] = {}
    for path in REQUIREMENTS_FILES:
        if not path.exists():
            continue
        for match in _REQUIREMENT.finditer(path.read_text(encoding="utf-8")):
            pins.setdefault(_canonical(match.group("name")), match.group("version"))
    return pins


def test_every_mypy_dependency_is_pinned() -> None:
    """An unpinned entry resolves to whatever PyPI serves when the cache is cold."""
    unpinned = sorted(name for name, version in _hook_pins().items() if version is None)
    assert not unpinned, (
        f"mypy additional_dependencies are unpinned: {unpinned}. "
        "Pin each with '==' so the type-check environment is reproducible."
    )


def test_mypy_pins_match_the_shipped_backend_versions() -> None:
    """The type checker must describe the libraries the application installs."""
    backend = _backend_pins()
    disagreements = {
        name: (version, backend[name])
        for name, version in _hook_pins().items()
        if version is not None and name in backend and version != backend[name]
    }
    assert not disagreements, (
        "mypy type-checks against versions the backend does not ship "
        f"(package: hook_pin vs requirements_pin): {disagreements}"
    )
