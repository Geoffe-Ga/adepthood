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


def parse_hook_pins(config: str) -> dict[str, str | None]:
    """Map each mypy ``additional_dependencies`` entry to its pinned version.

    A value of ``None`` marks an entry carrying no ``==`` pin at all.
    """
    match = _MYPY_DEPS.search(config)
    assert match is not None, "could not locate the mypy hook's additional_dependencies"
    pins: dict[str, str | None] = {}
    for entry in _QUOTED.findall(match.group("deps")):
        name, sep, version = entry.partition("==")
        pins[_canonical(name)] = version if sep else None
    return pins


def parse_requirement_pins(*sources: str) -> dict[str, str]:
    """Map every ``==``-pinned requirement to its version, first source winning."""
    pins: dict[str, str] = {}
    for source in sources:
        for match in _REQUIREMENT.finditer(source):
            pins.setdefault(_canonical(match.group("name")), match.group("version"))
    return pins


def find_unpinned(pins: dict[str, str | None]) -> list[str]:
    """Return the entries that would resolve to whatever PyPI serves that day."""
    return sorted(name for name, version in pins.items() if version is None)


def find_disagreements(
    hook: dict[str, str | None], backend: dict[str, str]
) -> dict[str, tuple[str, str]]:
    """Return every package the hook and the backend pin to different versions."""
    return {
        name: (version, backend[name])
        for name, version in hook.items()
        if version is not None and name in backend and version != backend[name]
    }


def _committed_hook_pins() -> dict[str, str | None]:
    """Parse the committed ``.pre-commit-config.yaml``."""
    return parse_hook_pins(PRECOMMIT_CONFIG.read_text(encoding="utf-8"))


def _committed_backend_pins() -> dict[str, str]:
    """Parse every committed backend requirements file."""
    return parse_requirement_pins(
        *(p.read_text(encoding="utf-8") for p in REQUIREMENTS_FILES if p.exists())
    )


def test_every_mypy_dependency_is_pinned() -> None:
    """An unpinned entry resolves to whatever PyPI serves when the cache is cold."""
    unpinned = find_unpinned(_committed_hook_pins())
    assert not unpinned, (
        f"mypy additional_dependencies are unpinned: {unpinned}. "
        "Pin each with '==' so the type-check environment is reproducible."
    )


def test_mypy_pins_match_the_shipped_backend_versions() -> None:
    """The type checker must describe the libraries the application installs."""
    disagreements = find_disagreements(_committed_hook_pins(), _committed_backend_pins())
    assert not disagreements, (
        "mypy type-checks against versions the backend does not ship "
        f"(package: hook_pin vs requirements_pin): {disagreements}"
    )


def test_the_guard_reads_a_populated_dependency_list() -> None:
    """A regex that silently matched nothing would make both invariants vacuous."""
    pins = _committed_hook_pins()
    assert len(pins) > 1, f"parsed only {len(pins)} mypy dependencies; the regex is not matching"
    assert "openai" in pins, "openai is absent from the parsed hook pins; the regex drifted"


# --- the alarm itself ---------------------------------------------------------
# Everything above runs against the committed config, which is correct today, so
# all of it passes whether or not the detection works at all. Neither the
# unpinned branch nor the mismatch branch is ever reached by a correct file.
# These drive fabricated inputs instead, because the guard's whole value is
# catching a *future* regression, and a detector that has never been shown to
# fire is exactly the shape of guard this repo keeps finding: green, and proving
# nothing.

_SYNTHETIC_CONFIG = """repos:
  - repo: https://github.com/pre-commit/mirrors-mypy
    rev: v1.0.0
    hooks:
      - id: mypy
        files: ^backend/
        additional_dependencies: ["openai==2.53.0", "httpx", "pydantic==2.13.4"]
"""

_SYNTHETIC_REQUIREMENTS = """openai==2.53.0
httpx==0.28.1
pydantic==9.9.9
# a comment line and a blank line follow

uvicorn==0.52.1
"""


def test_alarm_fires_on_an_unpinned_entry() -> None:
    """The exact shape that broke five pull requests: a bare package name."""
    assert find_unpinned(parse_hook_pins(_SYNTHETIC_CONFIG)) == ["httpx"]


def test_alarm_stays_silent_when_every_entry_is_pinned() -> None:
    """A fully pinned list must not be reported, or the guard cries wolf."""
    pinned = _SYNTHETIC_CONFIG.replace('"httpx"', '"httpx==0.28.1"')
    assert find_unpinned(parse_hook_pins(pinned)) == []


def test_alarm_fires_when_a_hook_pin_contradicts_the_backend() -> None:
    """Here the hook pins pydantic to 2.13.4 while the backend ships 9.9.9."""
    disagreements = find_disagreements(
        parse_hook_pins(_SYNTHETIC_CONFIG),
        parse_requirement_pins(_SYNTHETIC_REQUIREMENTS),
    )
    assert disagreements == {"pydantic": ("2.13.4", "9.9.9")}


def test_agreeing_pins_are_not_reported_as_disagreements() -> None:
    """Both sides agree on openai 2.53.0, so only genuine drift may be flagged."""
    disagreements = find_disagreements(
        parse_hook_pins(_SYNTHETIC_CONFIG),
        parse_requirement_pins(_SYNTHETIC_REQUIREMENTS),
    )
    assert "openai" not in disagreements


def test_an_unpinned_entry_is_never_counted_as_agreement() -> None:
    """An entry without a pin can neither agree nor disagree -- only be unpinned."""
    hook = parse_hook_pins(_SYNTHETIC_CONFIG)
    assert hook["httpx"] is None
    assert "httpx" not in find_disagreements(hook, parse_requirement_pins(_SYNTHETIC_REQUIREMENTS))


def test_the_first_requirements_source_wins() -> None:
    """Ordering matters: requirements.txt is the pin of record, the lock file echoes it."""
    assert parse_requirement_pins("httpx==0.28.1\n", "httpx==0.27.0\n")["httpx"] == "0.28.1"


def test_distribution_names_compare_case_and_separator_insensitively() -> None:
    """``PyJWT`` in the hook and ``pyjwt`` in the lock file are the same package."""
    hook = parse_hook_pins('repos:\n  - id: mypy\n    additional_dependencies: ["PyJWT==2.13.0"]\n')
    assert find_disagreements(hook, parse_requirement_pins("pyjwt==2.13.0\n")) == {}
    assert find_disagreements(hook, parse_requirement_pins("pyjwt==1.0.0\n")) == {
        "pyjwt": ("2.13.0", "1.0.0")
    }
