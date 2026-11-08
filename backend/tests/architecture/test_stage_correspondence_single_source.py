"""Only the stage seeder reads the static stage-correspondence artifact (#2666).

``curriculum/stage_correspondence.json`` is the one committed copy of the seven
per-Stage correspondence fields. ``seed_stages.py`` reconciles it into the
``CourseStage`` table at startup, and everything else reads the database:
``routers/stages.py`` serves ``GET /stages`` and ``GET /stages/correspondence``
from ``CourseStage`` columns, so it needs no entry here. A second production
reader of the static file would be a second path to the same fact -- one the
reconcile never touches -- which is the drift #2666 retired.

The allowlist is compared for exact equality, not as a superset: a stale entry
(a module that no longer imports the artifact) fails here too, so the list can
never quietly widen into a permit for a future reader.
"""

from __future__ import annotations

import ast
from pathlib import Path

_SRC = Path(__file__).resolve().parents[2] / "src"

#: The artifact loader's dotted module path.
_ARTIFACT_MODULE = "curriculum.stage_correspondence"

#: The only ``src`` modules allowed to import the artifact loader.
_ARTIFACT_READERS = frozenset({"seed_stages.py"})


def _package_of(relpath: str) -> str:
    """Return the dotted package a ``src``-relative module path lives in.

    ``curriculum/colours.py`` and ``curriculum/__init__.py`` are both in
    ``curriculum``; a top-level module such as ``seed_stages.py`` is in ``""``.
    """
    return ".".join(Path(relpath).parent.parts)


def _absolute_base(node: ast.ImportFrom, package: str) -> str:
    """Resolve a possibly-relative ``from ... import`` to its absolute module.

    ``from .x import y`` in package ``curriculum`` resolves to ``curriculum.x``;
    each extra leading dot climbs one package.
    """
    if not node.level:
        return node.module or ""
    parts = package.split(".") if package else []
    parts = parts[: len(parts) - (node.level - 1)]
    return ".".join([*parts, node.module] if node.module else parts)


def _imports_artifact(tree: ast.Module, package: str) -> bool:
    """Say whether ``tree`` imports :data:`_ARTIFACT_MODULE` in any spelling.

    Covers ``import curriculum.stage_correspondence``,
    ``from curriculum.stage_correspondence import ...``,
    ``from curriculum import stage_correspondence``, and the relative forms
    ``from .stage_correspondence import ...`` / ``from . import
    stage_correspondence`` resolved against the importing module's ``package``.
    """
    for node in ast.walk(tree):
        if isinstance(node, ast.Import) and any(
            alias.name == _ARTIFACT_MODULE for alias in node.names
        ):
            return True
        if isinstance(node, ast.ImportFrom):
            base = _absolute_base(node, package)
            if base == _ARTIFACT_MODULE:
                return True
            if any(f"{base}.{alias.name}" == _ARTIFACT_MODULE for alias in node.names):
                return True
    return False


def _artifact_readers(sources: dict[str, str]) -> frozenset[str]:
    """Return the module names in ``sources`` (name -> source text) that import the artifact."""
    return frozenset(
        name
        for name, text in sources.items()
        if _imports_artifact(ast.parse(text), _package_of(name))
    )


def _src_modules() -> dict[str, str]:
    """Every production module under ``src``, keyed by its path relative to ``src``.

    The artifact loader itself is excluded: it defines the module, it does not
    import it.
    """
    return {
        path.relative_to(_SRC).as_posix(): path.read_text(encoding="utf-8")
        for path in sorted(_SRC.rglob("*.py"))
        if path.relative_to(_SRC).as_posix() != "curriculum/stage_correspondence.py"
    }


def test_only_the_seeder_imports_the_stage_correspondence_artifact() -> None:
    """The set of artifact readers is exactly the seeder: no more, no fewer."""
    assert _artifact_readers(_src_modules()) == _ARTIFACT_READERS


def test_the_scan_catches_every_import_spelling() -> None:
    """Non-vacuity: a synthetic violator is found whichever import form it uses."""
    sources = {
        "seed_stages.py": "from curriculum.stage_correspondence import stage_correspondence\n",
        "routers/plain.py": "import curriculum.stage_correspondence\n",
        "routers/from_package.py": "from curriculum import stage_correspondence\n",
        "routers/clean.py": "from curriculum import stage_curriculum\nimport curriculum\n",
        "curriculum/colours.py": "from .stage_correspondence import stage_correspondence\n",
        "curriculum/__init__.py": "from . import stage_correspondence\n",
        "curriculum/deep/reader.py": "from ..stage_correspondence import stage_correspondence\n",
        "curriculum/clean_relative.py": "from . import stage_curriculum\n",
    }
    assert _artifact_readers(sources) == {
        "seed_stages.py",
        "routers/plain.py",
        "routers/from_package.py",
        "curriculum/colours.py",
        "curriculum/__init__.py",
        "curriculum/deep/reader.py",
    }
