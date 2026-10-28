"""The draft incident runbook names only controls that exist (#3075).

A runbook is read in the worst hour, by someone who will do exactly what it
says. A variable it names that the code never reads, or an endpoint that 404s,
is worse than no runbook: it costs the minutes it was written to save. So every
control the runbook names is checked against the source and the deployment
reference, every scenario it cites is checked against the tabletop module, and
the switch registry is checked against the runbook in the other direction.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path
from typing import Final

from main import app
from services.privacy_suspension import PRIVACY_SUSPENSION_SWITCHES

_REPO: Final = Path(__file__).resolve().parents[3]
_RUNBOOK: Final = _REPO / "docs" / "ops" / "privacy-incident-response.md"
_DEPLOYMENT: Final = _REPO / "DEPLOYMENT.md"
_SECURITY_MD: Final = _REPO / "frontend" / "SECURITY.md"
_SRC: Final = _REPO / "backend" / "src"
_TABLETOP: Final = Path(__file__).resolve().parent / "test_tabletop.py"

_DRAFT_MARKER: Final = "Draft — owner ratification required"
_DRAFT_WINDOW_LINES: Final = 5
#: Backticked environment-variable names. Requiring an underscore keeps
#: severity labels and placeholders (``SEV1``, ``OPERATOR``) out.
_ENV_TOKEN: Final = re.compile(r"`([A-Z][A-Z0-9]*_[A-Z0-9_]+)`")
_ADMIN_ROUTE: Final = re.compile(r"`(GET|POST|PUT|PATCH|DELETE) (/admin/[^`\s]*)`")
_TABLETOP_CITATION: Final = re.compile(r"test_tabletop::(\w+)")
_CLAIM_ROW: Final = re.compile(r"^\| (C\d{2}) \|(.*)$", re.MULTILINE)
_EXPECTED_CLAIMS: Final = frozenset({*(f"C{n:02d}" for n in range(4, 14)), "C21", "C24"})
_MIN_ENV_TOKENS: Final = 8
_MIN_TABLETOP_CITATIONS: Final = 7


def _runbook() -> str:
    return _RUNBOOK.read_text(encoding="utf-8")


def _source_string_literals() -> set[str]:
    """Every string constant anywhere under ``backend/src``."""
    found: set[str] = set()
    for path in _SRC.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        found.update(
            node.value
            for node in ast.walk(tree)
            if isinstance(node, ast.Constant) and isinstance(node.value, str)
        )
    return found


def _live_routes() -> set[tuple[str, str]]:
    """Every ``(METHOD, path)`` the running app serves, from its own OpenAPI render."""
    paths: dict[str, dict[str, object]] = app.openapi()["paths"]
    return {(method.upper(), path) for path, operations in paths.items() for method in operations}


def test_runbook_exists_and_is_marked_draft() -> None:
    """Nobody can mistake it for a ratified commitment."""
    head = _runbook().splitlines()[:_DRAFT_WINDOW_LINES]
    assert any(_DRAFT_MARKER in line for line in head), head


def test_runbook_names_only_real_controls() -> None:
    """Variables, admin routes and tabletop tests the runbook names all exist."""
    text = _runbook()
    deployment = _DEPLOYMENT.read_text(encoding="utf-8")
    literals = _source_string_literals()

    env_vars = set(_ENV_TOKEN.findall(text))
    assert len(env_vars) >= _MIN_ENV_TOKENS, sorted(env_vars)
    unread = sorted(var for var in env_vars if var not in literals)
    undocumented = sorted(var for var in env_vars if f"| `{var}` |" not in deployment)
    assert unread == [], f"runbook names variables the code never reads: {unread}"
    assert undocumented == [], f"runbook names variables DEPLOYMENT.md lacks: {undocumented}"

    routes = set(_ADMIN_ROUTE.findall(text))
    assert routes, "the runbook names no admin probe: the parse itself is broken"
    missing = sorted(f"{m} {p}" for m, p in routes if (m, p) not in _live_routes())
    assert missing == [], f"runbook names admin routes that do not exist: {missing}"

    switches = {switch.env_var for switch in PRIVACY_SUSPENSION_SWITCHES}
    assert switches <= env_vars, f"switches the runbook never names: {switches - env_vars}"

    cited = set(_TABLETOP_CITATION.findall(text))
    assert len(cited) >= _MIN_TABLETOP_CITATIONS, sorted(cited)
    tabletop = ast.parse(_TABLETOP.read_text(encoding="utf-8"))
    defined = {
        node.name
        for node in tabletop.body
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef)
    }
    assert cited <= defined, f"runbook cites tabletop tests that do not exist: {cited - defined}"


def test_every_claim_row_names_an_existing_control() -> None:
    """Each claim in scope has a row, and each row's control is a checked one."""
    rows = dict(_CLAIM_ROW.findall(_runbook()))
    assert set(rows) == _EXPECTED_CLAIMS

    for claim, rest in rows.items():
        control = rest.split("|")[1]
        assert _ENV_TOKEN.search(control) or "`GET /admin/" in control, (
            f"{claim}'s control names no variable or admin probe: {control!r}"
        )


def test_security_md_cites_no_phantom_on_call() -> None:
    """The developer guide no longer pages an on-call that does not exist."""
    text = " ".join(_SECURITY_MD.read_text(encoding="utf-8").split())

    assert "page the on-call" not in text
    assert "docs/ops/privacy-incident-response.md" in text
