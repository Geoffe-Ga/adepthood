"""merge ritual-03 and ritual-04 migration heads

Revision ID: c5ed9dd1dabc
Revises: 83b01b64cad3, f0a1b2c3d4e5
Create Date: 2026-05-11 18:55:00.000000

ritual-03 (``83b01b64cad3``: user-practice overrides) and ritual-04
(``f0a1b2c3d4e5``: practice-session metadata) were developed in parallel
and both used ``e9f0a1b2c3d4`` (ritual-01) as their ``down_revision``.
When both merged into ``main`` independently, the migration graph
forked into two heads, breaking ``alembic upgrade head`` with
"Multiple head revisions are present" — surfaced by the
``migration-drift`` CI job on the next PR.

This is a no-op merge migration (``upgrade``/``downgrade`` are empty)
whose sole purpose is to give the chain a single head by declaring
both prior heads as its ancestors. Future migrations chain off this
revision.
"""

from typing import Sequence, Union

# revision identifiers, used by Alembic.
revision: str = "c5ed9dd1dabc"  # pragma: allowlist secret
# Tuple of both prior heads; alembic stitches them together at this point.
down_revision: Union[str, Sequence[str], None] = (
    "83b01b64cad3",  # pragma: allowlist secret — ritual-03 head
    "f0a1b2c3d4e5",  # pragma: allowlist secret — ritual-04 head
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """No schema change; this migration only unifies the two prior heads."""


def downgrade() -> None:
    """Reverses to the forked state — both ritual-03 and ritual-04 remain applied."""
