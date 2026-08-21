"""Request and response DTOs for in-app account deletion."""

from __future__ import annotations

from pydantic import BaseModel, Field

# The address the caller has to retype. Bounded by the same ceiling the ``user``
# table puts on an email so an oversized body is refused at the edge rather
# than compared character by character.
_EMAIL_MAX_LENGTH = 254


class AccountDeletionRequest(BaseModel):
    """Explicit, typed confirmation that the caller means to be erased.

    The caller retypes their own email address. A confirmation the client could
    synthesise (a boolean, a fixed word) would make an accidental or replayed
    request indistinguishable from a deliberate one; an address the user has to
    read off their own account cannot be produced by a mis-tap.
    """

    confirm_email: str = Field(min_length=1, max_length=_EMAIL_MAX_LENGTH)


class VaultDisposition(BaseModel):
    """What the deletion did — and did not do — outside adepthood."""

    configured: bool
    purged: bool
    guidance: str


class AccountDeletionReceipt(BaseModel):
    """What the erasure reached, stated plainly enough to show a user.

    ``erased`` / ``anonymised`` / ``retained`` are the table names the policy
    classified, not row contents. They are returned so the client can render an
    honest "here is what happens" panel from the server's own policy instead of
    from prose that drifts away from it.
    """

    recoverable: bool
    rows_erased: int
    erased: list[str]
    anonymised: list[str]
    retained: list[str]
    vault: VaultDisposition
