"""Shared range bounds for every integer the API accepts from a client.

A bare ``int`` on a FastAPI parameter or body field renders into OpenAPI as
``type: integer`` and nothing else, so the published contract promises to accept
any integer JSON can express.  The value then travels the whole way to a
PostgreSQL ``integer`` column, where the driver refuses it with an
``OverflowError`` raised *inside* the handler -- which the unhandled-exception
middleware answers with a 500.  The caller sent a malformed request and was told
the server broke.

Declaring the bound where the parameter is declared moves that rejection forward
into FastAPI's parameter solving, where it becomes the 422 the caller earned,
and publishes it in the schema so a client can see the limit before sending.

An alias names the surface it bounds because FastAPI dispatches on the marker
class: ``Path`` and ``Query`` are what put ``minimum`` / ``maximum`` onto the
OpenAPI *parameter* object, while ``Field`` bounds a leaf inside a component
schema.  One alias therefore cannot serve two surfaces, and only the surfaces a
bound is actually declared on are spelled out here -- an unused alias is surface
nobody asked for.  Declarations written in assignment form (``x: int =
Query(default=0, ge=0)``) cannot take an alias at all, so the constants are
exported alongside the aliases and such a declaration gains the missing ``le=``
keyword instead.

Nothing in ``domain/`` may import this module: it depends on FastAPI, and the
domain layer is deliberately free of the web framework.  ``schemas/``,
``routers/`` and ``dependencies/`` all sit above it, so no cycle is possible.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Path, Query
from pydantic import Field

from domain.constants import TOTAL_PROGRAM_WEEKS, TOTAL_STAGES

# The largest value a PostgreSQL ``integer`` column holds, and therefore the
# exact point past which asyncpg raises rather than storing.  Not a JSON limit
# and not a Python limit: both of those are far larger, which is precisely why
# an unbounded field reaches the driver before anything objects.
INT32_MAX = 2_147_483_647

# Rows are numbered from one, so no identifier this application issues is ever
# zero or negative.  A request carrying one is malformed rather than unlucky.
MIN_ROW_ID = 1

# A count is a magnitude, so zero is its floor.
MIN_COUNT = 0

# PostgreSQL ``OFFSET`` takes a bigint, so int32 is not what constrains paging.
# What does is that no list this application serves holds a million rows: an
# offset past that is either a client bug or a sequential scan nobody should be
# able to ask the database to perform.
MAX_PAGE_OFFSET = 1_000_000

# The program's ten stages and thirty-six weeks are the true bound on a stage or
# week number -- tighter than the column, and more honest: stage eleven does not
# exist, so refusing it outright beats reaching the database to answer 404.
MIN_STAGE_NUMBER = 1
MIN_WEEK_NUMBER = 1

RowIdPath = Annotated[int, Path(ge=MIN_ROW_ID, le=INT32_MAX)]
RowIdQuery = Annotated[int, Query(ge=MIN_ROW_ID, le=INT32_MAX)]
RowIdField = Annotated[int, Field(ge=MIN_ROW_ID, le=INT32_MAX)]

CountField = Annotated[int, Field(ge=MIN_COUNT, le=INT32_MAX)]

StageNumberPath = Annotated[int, Path(ge=MIN_STAGE_NUMBER, le=TOTAL_STAGES)]
StageNumberQuery = Annotated[int, Query(ge=MIN_STAGE_NUMBER, le=TOTAL_STAGES)]
StageNumberField = Annotated[int, Field(ge=MIN_STAGE_NUMBER, le=TOTAL_STAGES)]

WeekNumberPath = Annotated[int, Path(ge=MIN_WEEK_NUMBER, le=TOTAL_PROGRAM_WEEKS)]
