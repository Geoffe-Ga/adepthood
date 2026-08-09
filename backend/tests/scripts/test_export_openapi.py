"""Tests for ``scripts/backend/export_openapi.py``.

The gate this script backs is only worth having if it can *fail*. A drift check
that always passes is worse than none: it certifies the artifact as current
while it rots. So the load-bearing case here is the one that mutates the
committed copy and asserts a non-zero exit.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import ModuleType

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
_SCRIPT = _REPO_ROOT / "scripts" / "backend" / "export_openapi.py"
_COMMITTED = _REPO_ROOT / "backend" / "openapi.json"


def _load_script() -> ModuleType:
    """Import the exporter by path -- ``scripts/`` is not an importable package."""
    spec = importlib.util.spec_from_file_location("export_openapi", _SCRIPT)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_the_committed_document_exists_and_is_a_valid_openapi_object() -> None:
    """The artifact is committed, not generated on demand, so it must be present."""
    assert _COMMITTED.exists(), "backend/openapi.json is not committed"
    spec = json.loads(_COMMITTED.read_text(encoding="utf-8"))
    assert spec["openapi"].startswith("3.")
    assert spec["paths"], "the document describes no routes"
    assert spec["components"]["schemas"], "the document describes no schemas"


def test_rendering_is_deterministic() -> None:
    """Two renders of one spec are byte-identical.

    Without this the gate would fire on dictionary ordering, everyone would
    learn to ignore it, and it would stop being a gate.
    """
    script = _load_script()
    spec = json.loads(_COMMITTED.read_text(encoding="utf-8"))
    assert script.render_spec(spec) == script.render_spec(spec)
    assert script.render_spec(spec).endswith("\n"), (
        "no trailing newline: the file will not diff cleanly"
    )


def test_check_passes_against_the_committed_document() -> None:
    """The committed artifact is current with the app as it stands."""
    script = _load_script()
    rendered = script.render_spec(script.load_spec())
    assert rendered == _COMMITTED.read_text(encoding="utf-8"), (
        "backend/openapi.json is stale; regenerate with `python scripts/backend/export_openapi.py`"
    )


def test_check_detects_drift(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """A committed copy that disagrees with the app exits non-zero.

    The case the whole gate rests on. Points the script at a temp file holding a
    mutated document, so the real artifact is never touched.
    """
    script = _load_script()
    drifted = json.loads(_COMMITTED.read_text(encoding="utf-8"))
    drifted["paths"]["/__a_route_the_app_does_not_serve__"] = {
        "get": {"responses": {"200": {"description": "ok"}}}
    }
    stale = tmp_path / "openapi.json"
    stale.write_text(json.dumps(drifted, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    monkeypatch.setattr(script, "_OUTPUT", stale)
    monkeypatch.setattr("sys.argv", ["export_openapi.py", "--check"])
    assert script.main() == 1


def test_check_reports_a_missing_document(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """An absent artifact fails rather than silently passing."""
    script = _load_script()
    monkeypatch.setattr(script, "_OUTPUT", tmp_path / "does-not-exist.json")
    monkeypatch.setattr("sys.argv", ["export_openapi.py", "--check"])
    assert script.main() == 1
