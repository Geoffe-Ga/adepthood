"""Creek Vault read path: source a Wheel-of-Wholeness balance, degrading safely.

This is the read-path consumer of the seam's ``wheel`` capability. Where the
seam adapter deliberately defers field-level validation of a wheel payload, this
module owns it: the adapter validates the wire *shape* against its Pydantic
schema and, on a malformed field, surfaces a :class:`pydantic.ValidationError`
rather than normalizing it to :class:`~domain.creek_vault.CreekVaultError`. This
module catches that error alongside the vault's own error hierarchy and falls
back, so a malformed-field wheel is indistinguishable from an absent vault to the
caller.

The governing rule is the same **graceful degradation** as the rest of the seam:
an absent, unreachable, capability-poor, or malformed-payload vault never raises
into the read path -- it collapses to ``None`` from :func:`fetch_vault_wheel`, and
:func:`select_wheel_balance` then computes the balance locally. Validation is
all-or-nothing: a single field or structural violation rejects the whole payload
rather than partially accepting it, so the frontend never renders a wheel spliced
from a trusted local half and an untrusted vault half.
"""

from __future__ import annotations

import pydantic
from sqlalchemy.ext.asyncio import AsyncSession

from domain.constants import TOTAL_STAGES
from domain.creek_vault import (
    CreekCapability,
    CreekVaultClient,
    CreekVaultError,
    VaultWheelAspect,
    VaultWheelBalance,
)
from domain.wheel import WheelItem, compute_wheel_balance

# The wheel carries exactly one aspect per curriculum stage; a payload of any
# other length is rejected outright.
VAULT_WHEEL_EXPECTED_ASPECTS = TOTAL_STAGES

# The stage-number range a valid aspect must fall within (inclusive), and the
# inclusive bounds on a fullness value.
VAULT_WHEEL_STAGE_MIN = 1
VAULT_WHEEL_FULLNESS_MIN = 0.0
VAULT_WHEEL_FULLNESS_MAX = 1.0


def _aspect_ok(aspect: VaultWheelAspect) -> bool:
    """Return whether a single aspect passes every field-level check.

    The fullness bound is a chained comparison, which is ``False`` for ``NaN``
    on either side -- so a ``NaN`` fullness is rejected without a special case.
    """
    return (
        VAULT_WHEEL_STAGE_MIN <= aspect.stage_number <= TOTAL_STAGES
        and bool(aspect.aspect.strip())
        and VAULT_WHEEL_FULLNESS_MIN <= aspect.fullness <= VAULT_WHEEL_FULLNESS_MAX
    )


def _stage_set_complete(aspects: tuple[VaultWheelAspect, ...]) -> bool:
    """Return whether the stage numbers are exactly ``{1 .. TOTAL_STAGES}`` (no dupes/gaps)."""
    return {aspect.stage_number for aspect in aspects} == set(
        range(VAULT_WHEEL_STAGE_MIN, TOTAL_STAGES + 1)
    )


def _balance_valid(aspects: tuple[VaultWheelAspect, ...]) -> bool:
    """Return whether a whole balance passes structural and field validation."""
    return (
        len(aspects) == VAULT_WHEEL_EXPECTED_ASPECTS
        and all(_aspect_ok(aspect) for aspect in aspects)
        and _stage_set_complete(aspects)
    )


def _to_items(aspects: tuple[VaultWheelAspect, ...]) -> list[WheelItem]:
    """Project validated aspects onto canonical-ordered wheel items (ascending by stage)."""
    return [
        WheelItem(stage_number=aspect.stage_number, aspect=aspect.aspect, fullness=aspect.fullness)
        for aspect in sorted(aspects, key=lambda item: item.stage_number)
    ]


async def _read_balance(client: CreekVaultClient) -> VaultWheelBalance | None:
    """Call the vault's wheel, mapping any seam or field-validation error to ``None``.

    A :class:`~domain.creek_vault.CreekVaultError` (unavailable or unsupported)
    and a :class:`pydantic.ValidationError` (a malformed field the adapter
    deliberately did not normalize) both degrade to ``None``.
    """
    try:
        return await client.wheel()
    except (CreekVaultError, pydantic.ValidationError):
        return None


async def fetch_vault_wheel(client: CreekVaultClient) -> list[WheelItem] | None:
    """Return the vault's validated wheel in canonical order, or ``None`` to fall back.

    Mirrors the gate order of the reflection read path: a handshake precedes any
    wheel call, and an unavailable vault or one that does not advertise WHEEL
    degrades before the call is made. A transport/field error from the call, or
    any field-level or structural validation violation on the returned balance,
    all collapse to ``None`` -- the signal for the caller to compute locally.
    """
    await client.handshake()
    if not (client.is_available() and client.supports(CreekCapability.WHEEL)):
        return None
    balance = await _read_balance(client)
    if balance is None or not _balance_valid(balance.aspects):
        return None
    return _to_items(balance.aspects)


async def select_wheel_balance(
    client: CreekVaultClient, session: AsyncSession, user_id: int
) -> list[WheelItem]:
    """Return the vault's wheel when available and valid, else the locally-computed balance."""
    items = await fetch_vault_wheel(client)
    return items if items is not None else await compute_wheel_balance(session, user_id)
