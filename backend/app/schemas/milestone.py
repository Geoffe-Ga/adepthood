"""Milestone schemas."""

from __future__ import annotations

from pydantic import BaseModel


class Milestone(BaseModel):
    threshold: int
