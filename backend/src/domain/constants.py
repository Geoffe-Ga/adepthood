"""Shared domain constants with no further domain imports.

Split from :mod:`domain.stage_progress` so Pydantic schemas can pull the
curriculum length without triggering a ``schemas <-> domain`` import cycle.
"""

from __future__ import annotations

# Declared length of the APTITUDE curriculum.  Router-level stage mutations
# clamp their inputs to this range and callers use it to detect the
# "everything is done" boundary.  Re-exported as ``TOTAL_STAGES`` from
# :mod:`domain.stage_progress` and aliased as ``MAX_STAGE_NUMBER`` by the
# Pydantic schemas.
TOTAL_STAGES = 36
