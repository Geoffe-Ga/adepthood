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


def parse_ignore_rules(config: str) -> dict[str, str]:
    """Map each ignored frontend dependency to the floor its rule names.

    Pure, so the detection below can be driven with a fabricated config. A
    guard whose alarm has only ever been pointed at a correct file has not been
    shown to ring at all.
    """
    block = _NPM_FRONTEND_BLOCK.search(config)
    assert block is not None, 'no `- package-ecosystem: "npm"` section in dependabot.yml'
    assert 'directory: "/frontend"' in block.group("body"), (
        "the npm section no longer points at /frontend; this guard is reading the wrong block"
    )
    return {m.group("name"): m.group("floor") for m in _IGNORE_ENTRY.finditer(block.group("body"))}


def find_stale_rules(rules: dict[str, str], installed: dict[str, str]) -> list[str]:
    """Return one message per rule whose floor has fallen to the installed line.

    A rule at or below what is installed no longer holds a future version back;
    it freezes the version in use, suppressing its patches — security fixes
    included — with no signal.
    """
    stale: list[str] = []
    for name, floor in rules.items():
        pinned = installed.get(name)
        if pinned is None:
            continue
        if _version_tuple(pinned) >= _version_tuple(floor):
            stale.append(
                f"{name}: installed {pinned} is at or above the ignored floor >={floor}, "
                f"so updates to the {pinned} line are silently suppressed",
            )
    return stale


def find_orphaned_rules(rules: dict[str, str], installed: dict[str, str]) -> list[str]:
    """Return every ignored package that is not a dependency any more."""
    return sorted(name for name in rules if name not in installed)


def _frontend_ignore_rules() -> dict[str, str]:
    """The rules as the committed ``dependabot.yml`` actually spells them."""
    return parse_ignore_rules(DEPENDABOT_CONFIG.read_text(encoding="utf-8"))


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
    stale = find_stale_rules(_frontend_ignore_rules(), _installed_frontend_versions())
    assert not stale, "stale dependabot ignore rules:\n  " + "\n  ".join(stale)


def test_every_ignore_rule_names_a_dependency_that_exists() -> None:
    """A rule for an uninstalled package is dead config.

    It reads as an active policy, so the next person treats the package as
    deliberately held back rather than simply gone.
    """
    orphaned = find_orphaned_rules(_frontend_ignore_rules(), _installed_frontend_versions())
    assert not orphaned, (
        f"dependabot ignores packages that frontend/package.json does not depend on: {orphaned}"
    )


# --- the alarm itself ---------------------------------------------------------
# Everything above runs against the committed config, which is correct today, so
# all of it passes whether or not the detection works at all. These drive
# fabricated inputs instead, because the guard's whole value is catching a
# *future* regression, and a detector that has never been shown to fire is
# exactly the shape of guard this repo keeps finding: green, and proving
# nothing.

_SYNTHETIC_CONFIG = """version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/frontend"
    ignore:
      - dependency-name: "left-pad"
        versions: [">=2.0.0"]
      - dependency-name: "right-pad"
        versions: [">=5.0.0"]

  - package-ecosystem: "pip"
    directory: "/backend"
"""


def test_the_parser_reads_a_config_it_has_not_seen() -> None:
    """Parsing is exercised against something other than the committed file."""
    assert parse_ignore_rules(_SYNTHETIC_CONFIG) == {
        "left-pad": "2.0.0",
        "right-pad": "5.0.0",
    }


def test_the_parser_stops_at_the_next_ecosystem() -> None:
    """A pip ignore rule must not be read as a frontend one.

    The block regex is what keeps the two apart; if it over-ran, a backend pin
    would be compared against frontend versions and report nonsense.
    """
    config = _SYNTHETIC_CONFIG.replace(
        '  - package-ecosystem: "pip"\n    directory: "/backend"\n',
        '  - package-ecosystem: "pip"\n'
        '    directory: "/backend"\n'
        "    ignore:\n"
        '      - dependency-name: "not-a-frontend-package"\n'
        '        versions: [">=9.0.0"]\n',
    )
    assert "not-a-frontend-package" not in parse_ignore_rules(config)


def test_a_floor_at_the_installed_version_is_reported() -> None:
    """The exact defect this guard exists for: floor == installed.

    This is the shape the typescript rule had -- `>=6.0.0` against an installed
    `~6.0.3` -- where the rule reads like a policy and behaves like a freeze.
    """
    stale = find_stale_rules({"left-pad": "2.0.0"}, {"left-pad": "2.0.0"})
    assert len(stale) == 1
    assert "left-pad" in stale[0]


def test_a_floor_below_the_installed_version_is_reported() -> None:
    """A floor the project has already moved past is equally frozen."""
    assert find_stale_rules({"left-pad": "2.0.0"}, {"left-pad": "~2.4.1"}) != []


def test_a_floor_above_the_installed_version_is_not_reported() -> None:
    """The healthy case stays quiet, so the alarm means something when it fires."""
    assert find_stale_rules({"left-pad": "2.0.0"}, {"left-pad": "~1.9.9"}) == []


def test_an_uninstalled_package_is_not_reported_as_stale() -> None:
    """Absence is the orphan check's business, not this one's.

    Reporting it here too would make one edit trip two alarms and blur which
    invariant actually broke.
    """
    assert find_stale_rules({"left-pad": "2.0.0"}, {}) == []


def test_an_orphaned_rule_is_reported() -> None:
    """A rule naming a package nobody depends on any more."""
    assert find_orphaned_rules({"left-pad": "2.0.0"}, {"right-pad": "1.0.0"}) == ["left-pad"]


def test_an_installed_package_is_not_reported_as_orphaned() -> None:
    """The healthy case, again -- both detectors have a proven quiet side."""
    assert find_orphaned_rules({"left-pad": "2.0.0"}, {"left-pad": "~1.0.0"}) == []
