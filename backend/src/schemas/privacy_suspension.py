"""The content-free operator view of the privacy suspension switches (#3075)."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class PrivacySuspensionStatus(BaseModel):
    """Which operator suspension switches are on: two booleans and nothing else.

    The "time to safe state" probe an operator reads after flipping a switch and
    restarting. Flat and closed (``extra="forbid"``) so no account, content or
    raw environment value can ever be added to it by accident.
    """

    model_config = ConfigDict(extra="forbid")

    external_ai_suspended: bool
    vault_send_suspended: bool
