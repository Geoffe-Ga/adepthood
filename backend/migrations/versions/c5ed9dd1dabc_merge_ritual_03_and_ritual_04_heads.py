"""merge ritual-03 and ritual-04 migration heads

Revision ID: c5ed9dd1dabc
Revises: 83b01b64cad3, b1c2d3e4f5a6
Create Date: 2026-05-11 18:55:00.000000

ritual-03 (``83b01b64cad3``: user-practice overrides) and ritual-04
(``f0a1b2c3d4e5``: practice-session metadata) were developed in parallel
and both used ``e9f0a1b2c3d4`` (ritual-01) as their ``down_revision``.
When both merged into ``main`` independently, the migration graph
forked into two heads, breaking ``alembic upgrade head`` with
"Multiple head revisions are present" — surfaced by the
``migration-drift`` CI job on the next PR.

After this PR's initial fix, PR #316 ("12B wave 2") added two
follow-on migrations (``a0b1c2d3e4f5`` journal soft-delete and
``b1c2d3e4f5a6`` chat-spend idempotency) chained off ``f0a1b2c3d4e5``,
re-forking the graph relative to this merge. ``down_revision`` is
therefore pinned to the *current* heads of both branches:
``83b01b64cad3`` (ritual-03, never built on) and ``b1c2d3e4f5a6``
(end of the ritual-04 → soft-delete → chat-spend chain). Future
migrations chain off this revision; an even later sibling on the
ritual-03 branch would re-fork and warrant another merge.

This is a no-op merge migration (``upgrade``/``downgrade`` are empty)
whose sole purpose is to give the chain a single head by declaring
both prior heads as its ancestors.
"""

from typing import Sequence, Union

# revision identifiers, used by Alembic.
revision: str = "c5ed9dd1dabc"  # pragma: allowlist secret
# Tuple of both current heads; alembic stitches them together at this point.
down_revision: Union[str, Sequence[str], None] = (
    "83b01b64cad3",  # pragma: allowlist secret — ritual-03 head
    "b1c2d3e4f5a6",  # pragma: allowlist secret — chat-spend (end of ritual-04 chain)
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """No schema change; this migration only unifies the two prior heads."""


def downgrade() -> None:
    """Reverses to the forked state — the prior heads remain applied."""
