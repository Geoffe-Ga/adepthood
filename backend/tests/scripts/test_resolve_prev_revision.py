"""Tests for ``backend/scripts/resolve_prev_revision.py``.

The script exists so ``alembic downgrade -1`` — which is ambiguous when the
head is a merge migration — can be replaced in CI with an explicit prior
revision. The script must support every branch of a merge head so the
``migration-drift`` job can exercise both downgrade paths, not just the
default first parent.
"""

from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from scripts.resolve_prev_revision import main as cli
from scripts.resolve_prev_revision import resolve_prev_revision


@pytest.fixture
def linear_chain(tmp_path: Path) -> Path:
    """Two-revision linear chain. ``head`` → ``parent`` → None."""
    versions = tmp_path / "versions"
    versions.mkdir()
    (versions / "001_parent.py").write_text(
        textwrap.dedent(
            """
            revision = "parent"
            down_revision = None
            branch_labels = None
            depends_on = None
            def upgrade() -> None: ...
            def downgrade() -> None: ...
            """
        ).strip()
    )
    (versions / "002_head.py").write_text(
        textwrap.dedent(
            """
            revision = "head"
            down_revision = "parent"
            branch_labels = None
            depends_on = None
            def upgrade() -> None: ...
            def downgrade() -> None: ...
            """
        ).strip()
    )
    _write_alembic_ini(tmp_path, versions)
    return tmp_path


@pytest.fixture
def merge_chain(tmp_path: Path) -> Path:
    """Diamond: ``merge`` head with parents ``left`` and ``right`` (in that order)."""
    versions = tmp_path / "versions"
    versions.mkdir()
    for name, parent in [("base", "None"), ("left", '"base"'), ("right", '"base"')]:
        (versions / f"{name}.py").write_text(
            textwrap.dedent(
                f"""
                revision = "{name}"
                down_revision = {parent}
                branch_labels = None
                depends_on = None
                def upgrade() -> None: ...
                def downgrade() -> None: ...
                """
            ).strip()
        )
    (versions / "merge.py").write_text(
        textwrap.dedent(
            """
            revision = "merge"
            down_revision = ("left", "right")
            branch_labels = None
            depends_on = None
            def upgrade() -> None: ...
            def downgrade() -> None: ...
            """
        ).strip()
    )
    _write_alembic_ini(tmp_path, versions)
    return tmp_path


def _write_alembic_ini(root: Path, versions: Path) -> None:
    (root / "alembic.ini").write_text(
        textwrap.dedent(
            f"""
            [alembic]
            script_location = {root!s}
            version_locations = {versions!s}
            file_template = %%(rev)s
            sqlalchemy.url = sqlite://
            """
        ).strip()
    )


def test_linear_chain_returns_the_single_parent(linear_chain: Path) -> None:
    """Linear chain: downgrade -1 is unambiguous; script returns that single parent."""
    assert resolve_prev_revision(linear_chain / "alembic.ini") == "parent"


def test_merge_chain_returns_first_parent_by_default(merge_chain: Path) -> None:
    """Default ``branch=0`` selects the first parent (back-compat with prior CI heredoc)."""
    assert resolve_prev_revision(merge_chain / "alembic.ini") == "left"


def test_merge_chain_returns_second_parent_when_branch_is_one(merge_chain: Path) -> None:
    """``branch=1`` is what unblocks exercising the ritual-04 downgrade path."""
    assert resolve_prev_revision(merge_chain / "alembic.ini", branch=1) == "right"


def test_branch_index_out_of_range_raises(merge_chain: Path) -> None:
    """Out-of-range branch index surfaces as a clear ``IndexError`` to the operator."""
    with pytest.raises(IndexError, match="branch index 5"):
        resolve_prev_revision(merge_chain / "alembic.ini", branch=5)


def test_transient_multi_head_returns_dash_one(tmp_path: Path) -> None:
    """Forked / unmerged heads fall back to ``-1`` so alembic's own error surfaces."""
    versions = tmp_path / "versions"
    versions.mkdir()
    for name in ("alpha", "beta"):
        (versions / f"{name}.py").write_text(
            textwrap.dedent(
                f"""
                revision = "{name}"
                down_revision = None
                branch_labels = None
                depends_on = None
                def upgrade() -> None: ...
                def downgrade() -> None: ...
                """
            ).strip()
        )
    _write_alembic_ini(tmp_path, versions)

    assert resolve_prev_revision(tmp_path / "alembic.ini") == "-1"


def test_root_revision_returns_dash_one(tmp_path: Path) -> None:
    """Root-only graph (no parent to downgrade to) falls back to ``-1``."""
    versions = tmp_path / "versions"
    versions.mkdir()
    (versions / "001_root.py").write_text(
        textwrap.dedent(
            """
            revision = "root"
            down_revision = None
            branch_labels = None
            depends_on = None
            def upgrade() -> None: ...
            def downgrade() -> None: ...
            """
        ).strip()
    )
    _write_alembic_ini(tmp_path, versions)

    assert resolve_prev_revision(tmp_path / "alembic.ini") == "-1"


def test_cli_entrypoint_prints_revision_to_stdout(
    merge_chain: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """CLI entrypoint prints the resolved revision so CI can capture via ``$(...)``."""
    exit_code = cli([str(merge_chain / "alembic.ini"), "--branch", "1"])
    assert exit_code == 0
    captured = capsys.readouterr()
    assert captured.out.strip() == "right"


def test_cli_default_branch_is_zero(merge_chain: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """Default invocation (no ``--branch``) prints the first parent."""
    cli([str(merge_chain / "alembic.ini")])
    assert capsys.readouterr().out.strip() == "left"
