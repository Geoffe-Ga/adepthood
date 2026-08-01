"""Creek Vault read path: source a Wheel-of-Wholeness balance, degrading safely.

This is the read-path consumer of the seam's ``wheel`` capability. The adapter
underneath it owns creek's wire shape, and degrades a malformed or refused wheel
payload to :class:`~domain.creek_vault.CreekVaultError` exactly as every other
capability does; nothing but that one error hierarchy crosses into this module.
Three jobs are left here, and they are this module's alone: validating the
*domain ranges* of whatever any client implementation returns, deciding whether
a well-formed vault wheel is even worth preferring over the locally-computed
balance, and projecting the vault's counts onto adepthood's own Aspect
vocabulary.

The governing rule is the same **graceful degradation** as the rest of the seam:
an absent, unreachable, capability-poor, or malformed-payload vault never raises
into the read path -- it collapses to ``None`` from :func:`fetch_vault_wheel`, and
:func:`select_wheel_balance` then computes the balance locally. Validation is
all-or-nothing: a single field or structural violation rejects the whole payload
rather than partially accepting it, so the frontend never renders a wheel spliced
from a trusted local half and an untrusted vault half.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from domain.constants import TOTAL_STAGES
from domain.creek_vault import (
    CreekCapability,
    CreekVaultClient,
    CreekVaultError,
    VaultWheelAspect,
    VaultWheelBalance,
)
from domain.wheel import WheelItem, aspect_labels_by_stage, compute_wheel_balance

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


def _carries_signal(items: list[WheelItem]) -> bool:
    """Return whether any aspect reads above the fullness floor.

    An all-zero wheel is *valid* creek output -- an empty or wholly-unclassified
    corpus reads exactly that way -- but it says nothing, and rendering it would
    blank a Map the local balance can fill from the user's own habits, practice,
    and course progress. The rule is deliberately "no positive value anywhere",
    never "reject any zero": a real corpus concentrated in one Aspect
    legitimately reads nine zeros and one number.
    """
    return any(item["fullness"] > VAULT_WHEEL_FULLNESS_MIN for item in items)


def _usable_items(balance: VaultWheelBalance | None) -> list[WheelItem] | None:
    """Return a balance's items in canonical order when it both validates and says something."""
    if balance is None or not _balance_valid(balance.aspects):
        return None
    items = _to_items(balance.aspects)
    return items if _carries_signal(items) else None


async def _read_balance(client: CreekVaultClient) -> VaultWheelBalance | None:
    """Call the vault's wheel, mapping any seam error to ``None``.

    :class:`~domain.creek_vault.CreekVaultError` is the only thing the seam can
    raise: the adapter normalizes a malformed or refused payload into it exactly
    as it does an unreachable or unadvertised vault, so one ``except`` covers
    every way the call can fail to produce a wheel.
    """
    try:
        return await client.wheel()
    except CreekVaultError:
        return None


async def fetch_vault_wheel(client: CreekVaultClient) -> list[WheelItem] | None:
    """Return the vault's validated wheel in canonical order, or ``None`` to fall back.

    Mirrors the gate order of the reflection read path: a handshake precedes any
    wheel call, and an unavailable vault or one that does not advertise WHEEL
    degrades before the call is made. Every remaining way to end up without a
    usable wheel -- a seam error from the call, a field-level or structural
    violation on the returned balance, or a well-formed but wholly-zero wheel --
    collapses to ``None``, the signal for the caller to compute locally.
    """
    await client.handshake()
    if not (client.is_available() and client.supports(CreekCapability.WHEEL)):
        return None
    return _usable_items(await _read_balance(client))


async def _relabelled_items(
    session: AsyncSession, items: list[WheelItem]
) -> list[WheelItem] | None:
    """Re-label vault items with adepthood's own Aspect words, or ``None`` if it cannot be done.

    The vault owns the counts; adepthood owns the vocabulary, so a wheel sourced
    from the vault still reads in the words of the course. Every stage needs a
    non-blank ``CourseStage`` label: one missing or blank row discards the whole
    vault wheel, because a ring that is half creek's vocabulary and half a gap is
    worse than the local balance it would have replaced.
    """
    labels = await aspect_labels_by_stage(session, [item["stage_number"] for item in items])
    relabelled = [
        WheelItem(stage_number=item["stage_number"], aspect=label, fullness=item["fullness"])
        for item in items
        if (label := labels.get(item["stage_number"], "")).strip()
    ]
    return relabelled if len(relabelled) == len(items) else None


async def select_wheel_balance(
    client: CreekVaultClient, session: AsyncSession, user_id: int
) -> list[WheelItem]:
    """Return the vault's wheel in adepthood's Aspect words, else the locally-computed balance.

    One source per wheel: a vault wheel that cannot be relabelled in full is
    discarded outright rather than rendered as a hybrid of a vault half and a
    broken local half.
    """
    items = await fetch_vault_wheel(client)
    relabelled = None if items is None else await _relabelled_items(session, items)
    if relabelled is not None:
        return relabelled
    return await compute_wheel_balance(session, user_id)
