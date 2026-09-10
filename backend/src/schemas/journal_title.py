"""Shared validation for every request path that can write a journal title."""

from __future__ import annotations

import re
from typing import Annotated

from pydantic import BeforeValidator


def _single_line_title(title: object) -> object:
    """Collapse any pasted line-break run into one ordinary space."""
    return re.sub(r"[\r\n]+", " ", title) if isinstance(title, str) else title


JournalTitle = Annotated[str, BeforeValidator(_single_line_title)]
