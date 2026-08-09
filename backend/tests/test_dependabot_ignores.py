"""Guards against stale ``ignore`` rules in ``.github/dependabot.yml``.

An ignore rule pins a *floor*: ``versions: [">=6.0.0"]`` tells Dependabot never
to propose 6.0.0 or later. That is correct while the installed version is below
the floor. The moment the project adopts a version at or above it -- by an
`expo install`, an SDK migration, a hand-edit -- the rule silently changes
meaning. It stops holding a line back and starts freezing the line we are on,
so patch and security releases for the version actually in use are never
proposed and nobody is told.

That is not hypothetical: the ``typescript`` rule read ``>=6.0.0`` while
``frontend/package.json`` pinned ``~6.0.3``, so every TypeScript 6.x patch was
suppressed.

The invariant below is the one that catches it: for every ignored dependency,
the installed version must sit strictly *below* the floor the rule names. A
rule that does not hold that is either stale or was never true.

The file is parsed as text on purpose -- PyYAML is deliberately absent from
every requirements file in this repo, and adding a parser dependency to guard a
config file would be a poor trade.
"""

from __future__ import annotations

import json
import pathlib
import re

BACKEND_DIR = pathlib.Path(__file__).resolve().parent.parent
REPO_ROOT = BACKEND_DIR.parent
DEPENDABOT_CONFIG = REPO_ROOT / ".github" / "dependabot.yml"
FRONTEND_MANIFEST = REPO_ROOT / "frontend" / "package.json"

_NPM_FRONTEND_BLOCK = re.compile(
    r'^  - package-ecosystem: "npm"\n(?P<body>(?:.*\n)*?)(?=^  - package-ecosystem:|\Z)',
    re.MULTILINE,
)
_IGNORE_ENTRY = re.compile(
    r'-\s*dependency-name:\s*"(?P<name>[^"]+)"\s*\n\s*versions:\s*\[">=(?P<floor>[^"]+)"\]',
)


def _version_tuple(raw: str) -> tuple[int, ...]:
    """Turn a version or npm range into comparable integers.

    Drops whatever precedes the first digit -- the range operators npm allows
    on a pinned version (``^``, ``~``, ``>=`` and friends) -- and keeps the
    leading numeric components. Pre-release suffixes are dropped too:
    ``6.0.3-beta.1`` compares as ``(6, 0, 3)``, which is the resolution this
    guard needs and no finer.
    """
    cleaned = re.sub(r"^\D*", "", raw.strip())
    parts: list[int] = []
    for component in cleaned.split("."):
        match = re.match(r"\d+", component)
        if match is None:
            break
        parts.append(int(match.group()))
    return tuple(parts)


def _frontend_ignore_rules() -> dict[str, str]:
    """Map each ignored frontend dependency to the floor its rule names."""
    config = DEPENDABOT_CONFIG.read_text(encoding="utf-8")
    block = _NPM_FRONTEND_BLOCK.search(config)
    assert block is not None, 'no `- package-ecosystem: "npm"` section in dependabot.yml'
    assert 'directory: "/frontend"' in block.group("body"), (
        "the npm section no longer points at /frontend; this guard is reading the wrong block"
    )
    return {m.group("name"): m.group("floor") for m in _IGNORE_ENTRY.finditer(block.group("body"))}


def _installed_frontend_versions() -> dict[str, str]:
    """Every dependency pinned by ``frontend/package.json``, prod and dev alike."""
    manifest = json.loads(FRONTEND_MANIFEST.read_text(encoding="utf-8"))
    return {**manifest.get("dependencies", {}), **manifest.get("devDependencies", {})}


def test_the_guard_finds_the_rules_it_claims_to_check() -> None:
    """Fail loudly if the parse returns nothing.

    Without this, a format change in dependabot.yml would empty the rule set and
    every assertion below would pass over zero rules -- reporting green while
    checking nothing at all.
    """
    rules = _frontend_ignore_rules()
    assert rules, "parsed no ignore rules; the guard below would be vacuous"


def test_no_ignore_rule_freezes_the_version_in_use() -> None:
    """Every ignored dependency must be installed *below* its rule's floor.

    When the installed version reaches the floor, the rule stops holding a
    future line back and starts suppressing updates to the current one --
    including security patches -- with no signal that it happened.
    """
    installed = _installed_frontend_versions()
    stale: list[str] = []
    for name, floor in _frontend_ignore_rules().items():
        pinned = installed.get(name)
        if pinned is None:
            continue
        if _version_tuple(pinned) >= _version_tuple(floor):
            stale.append(
                f"{name}: installed {pinned} is at or above the ignored floor >={floor}, "
                f"so updates to the {pinned} line are silently suppressed",
            )
    assert not stale, "stale dependabot ignore rules:\n  " + "\n  ".join(stale)


def test_every_ignore_rule_names_a_dependency_that_exists() -> None:
    """A rule for an uninstalled package is dead config.

    It reads as an active policy, so the next person treats the package as
    deliberately held back rather than simply gone.
    """
    installed = _installed_frontend_versions()
    orphaned = sorted(name for name in _frontend_ignore_rules() if name not in installed)
    assert not orphaned, (
        f"dependabot ignores packages that frontend/package.json does not depend on: {orphaned}"
    )
