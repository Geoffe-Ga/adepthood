"""The privacy guards #3163 mutates, each with the permissive no-op that replaces it.

Read by the mutation plugin (:mod:`tests.support.privacy_guard_mutation`) inside
a nested pytest run, and by the meta-test that drives it
(``tests/security/test_privacy_guard_mutations.py``).

**How a guard is replaced.** The guard function's ``__code__`` is swapped for
its replacement's, in place. Swapping the attribute on its module would miss
every ``from module import guard`` binding taken before the swap, and nearly
every caller takes one; the function object those bindings share is the one
thing they all see. The replacement keeps the guard's parameters, and its body
runs against the *guard's* module globals -- so :func:`unfit_reasons` checks
both, because a replacement with a different signature or naming a global its
guard's module lacks would fail its suite with a ``TypeError`` or ``NameError``,
a red run that proves nothing about the guard.
"""

from __future__ import annotations

import builtins
import dis
import importlib
import inspect
from collections.abc import AsyncIterator, Callable, Iterable
from dataclasses import dataclass
from types import CodeType, FunctionType
from typing import Final

from sqlalchemy import ColumnElement, SQLColumnExpression, or_
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from domain.creek_vault import CreekVaultClient, CreekVaultError
from models.journal_entry import JournalEntry
from services.marginalia import BotmasonResonanceLLM
from services.reflection_boundary import ReflectionBoundary
from services.restore_suppression import AccountTombstone, EntryTombstone
from services.voice_draft_privacy import OnUnavailable

_ASYNC_FLAGS: Final = inspect.CO_COROUTINE | inspect.CO_ASYNC_GENERATOR | inspect.CO_GENERATOR
_GLOBAL_LOADS: Final = frozenset({"LOAD_GLOBAL", "LOAD_NAME"})


class GuardMutationError(RuntimeError):
    """A mutation row that cannot be applied faithfully."""


@dataclass(frozen=True, slots=True)
class GuardMutation:
    """One privacy guard, the permissive no-op that replaces it, and the claims it backs."""

    name: str
    module: str
    attribute: str
    claims: tuple[str, ...]
    replacement: Callable[..., object]


# ── Permissive replacements ──────────────────────────────────────────────────
#
# Each keeps its guard's parameters and drops the check. A body reads only
# builtins or names the guard's own module imports: it runs against that
# module's globals once swapped in.


def _admits_every_tier(classification: object) -> bool:
    """``admits_egress`` that lets Intimate, ``None`` and unknown tiers leave."""
    del classification
    return True


def _every_tier_is_eligible(column: SQLColumnExpression[str]) -> ColumnElement[bool]:
    """``egress_eligible_clause`` that selects Intimate, unknown and ``NULL`` rows too."""
    return or_(column.is_(None), column.is_not(None))


def _app_provider_whatever_the_boundary(
    boundary: ReflectionBoundary, api_key: str | None
) -> BotmasonResonanceLLM | None:
    """``app_provider_llm`` that hands a vault-bound caller the app provider."""
    del boundary
    return BotmasonResonanceLLM(api_key)


def _require_app_provider_whatever_the_boundary(
    boundary: ReflectionBoundary, api_key: str | None
) -> BotmasonResonanceLLM:
    """``require_app_provider_llm`` that never refuses."""
    del boundary
    return BotmasonResonanceLLM(api_key)


async def _hold_nothing(
    session: AsyncSession,
    user_id: int,
    *,
    on_unavailable: OnUnavailable = "refuse",
) -> AsyncIterator[None]:
    """``hold_account`` that enters without taking the account barrier."""
    del session, user_id, on_unavailable
    yield


async def _every_account_is_live(session: AsyncSession, user_id: int) -> None:
    """``ensure_account_live`` that never refuses an erased account."""
    del session, user_id


def _reason_from_the_message(exc: BaseException) -> str:
    """``exception_reason`` that reads the exception's own text."""
    return str(exc)


def _ship_the_event_as_is(event: dict[str, object], hint: dict[str, object]) -> dict[str, object]:
    """``scrub_event`` that forwards the SDK's event untouched."""
    del hint
    return event


async def _skip_the_account_tombstone(
    factory: async_sessionmaker[AsyncSession], tombstone: AccountTombstone, tally: object
) -> None:
    """``_reapply_account`` that leaves a resurrected account in place."""
    del factory, tombstone, tally


async def _skip_the_entry_tombstone(
    factory: async_sessionmaker[AsyncSession], tombstone: EntryTombstone, tally: object
) -> None:
    """``_reapply_entry`` that leaves a resurrected entry live."""
    del factory, tombstone, tally


async def _assume_the_withdrawal_landed(client: CreekVaultClient, entry_id: int) -> bool:
    """``_withdrawal_is_confirmed`` that asks Creek but believes it whatever it says."""
    try:
        await client.withdraw_journal_entry(entry_id)
    except CreekVaultError:
        return True
    return True


def _withhold_nothing(body: str, passages: Iterable[str]) -> str:
    """``withhold_passages`` that sends a folded Intimate passage as written."""
    del passages
    return body


def _every_quote_is_foldable(
    source: JournalEntry, text: str, source_passages: tuple[str, ...]
) -> bool:
    """``quote_is_foldable`` that offers and folds a quote of Intimate text."""
    del source, text, source_passages
    return True


async def _every_span_is_quotable(
    session: AsyncSession, entry: JournalEntry, start: int, end: int
) -> None:
    """``refuse_unquotable_span`` that promotes a span of an Intimate entry."""
    del session, entry, start, end


#: Every guard #3163 names, each against the claims whose suite must notice it.
#:
#: C10 is held to the SQL form of the predicate rather than to
#: :func:`~domain.privacy_tier.admits_egress`: the paths that gather *other*
#: entries as context (prior letters, Higher Self grounding) select with
#: :func:`~domain.privacy_tier.egress_eligible_clause` and never call the Python
#: predicate, so replacing ``admits_egress`` leaves C10's behavior unchanged.
PRIVACY_GUARDS: Final[tuple[GuardMutation, ...]] = (
    GuardMutation(
        "admits_egress",
        "domain.privacy_tier",
        "admits_egress",
        ("C07", "C08", "C09", "C11"),
        _admits_every_tier,
    ),
    GuardMutation(
        "egress_eligible_clause",
        "domain.privacy_tier",
        "egress_eligible_clause",
        ("C10",),
        _every_tier_is_eligible,
    ),
    GuardMutation(
        "app_provider_llm",
        "services.reflection_boundary",
        "app_provider_llm",
        ("C13", "C23"),
        _app_provider_whatever_the_boundary,
    ),
    GuardMutation(
        "require_app_provider_llm",
        "services.reflection_boundary",
        "require_app_provider_llm",
        ("C13", "C23"),
        _require_app_provider_whatever_the_boundary,
    ),
    GuardMutation(
        "hold_account",
        "services.account_egress_barrier",
        "hold_account",
        ("C21",),
        _hold_nothing,
    ),
    GuardMutation(
        "ensure_account_live",
        "services.account_egress_barrier",
        "ensure_account_live",
        ("C21",),
        _every_account_is_live,
    ),
    GuardMutation(
        "exception_reason",
        "telemetry_safety",
        "exception_reason",
        ("C12",),
        _reason_from_the_message,
    ),
    GuardMutation(
        "scrub_event",
        "sentry",
        "scrub_event",
        ("C12",),
        _ship_the_event_as_is,
    ),
    GuardMutation(
        "reapply_account_tombstone",
        "services.restore_suppression",
        "_reapply_account",
        ("C21",),
        _skip_the_account_tombstone,
    ),
    GuardMutation(
        "reapply_entry_tombstone",
        "services.restore_suppression",
        "_reapply_entry",
        ("C21",),
        _skip_the_entry_tombstone,
    ),
    GuardMutation(
        "withdrawal_is_confirmed",
        "services.creek_vault_withdraw",
        "_withdrawal_is_confirmed",
        ("C11", "C21"),
        _assume_the_withdrawal_landed,
    ),
    # Owner decision R5-2 (#3059): Intimate text is excluded from folded quotes.
    GuardMutation(
        "withhold_passages",
        "domain.folded_passages",
        "withhold_passages",
        ("C10",),
        _withhold_nothing,
    ),
    GuardMutation(
        "quote_is_foldable",
        "services.folded_quote_privacy",
        "quote_is_foldable",
        ("C10",),
        _every_quote_is_foldable,
    ),
    GuardMutation(
        "refuse_unquotable_span",
        "services.folded_quote_privacy",
        "refuse_unquotable_span",
        ("C10",),
        _every_span_is_quotable,
    ),
)

GUARDS_BY_NAME: Final = {guard.name: guard for guard in PRIVACY_GUARDS}


# ── Applying one ─────────────────────────────────────────────────────────────


def guard_function(mutation: GuardMutation) -> FunctionType:
    """The function object whose code the mutation replaces (decorators unwrapped)."""
    module = importlib.import_module(mutation.module)
    target = inspect.unwrap(getattr(module, mutation.attribute))
    if not isinstance(target, FunctionType):
        msg = f"{mutation.module}.{mutation.attribute} is not a plain function"
        raise GuardMutationError(msg)
    return target


def _parameters(code: CodeType) -> tuple[str, ...]:
    count = code.co_argcount + code.co_kwonlyargcount
    return code.co_varnames[:count]


def _global_reads(code: CodeType) -> frozenset[str]:
    return frozenset(
        str(instruction.argval)
        for instruction in dis.get_instructions(code)
        if instruction.opname in _GLOBAL_LOADS
    )


def unfit_reasons(mutation: GuardMutation, target: FunctionType) -> list[str]:
    """Why ``mutation.replacement`` cannot stand in for ``target``, or nothing."""
    guard, swap = target.__code__, mutation.replacement.__code__
    reasons: list[str] = []
    if _parameters(guard) != _parameters(swap):
        reasons.append(f"parameters {_parameters(swap)} differ from {_parameters(guard)}")
    if guard.co_flags & _ASYNC_FLAGS != swap.co_flags & _ASYNC_FLAGS:
        reasons.append("sync/async/generator kind differs from the guard's")
    if guard.co_freevars or swap.co_freevars:
        reasons.append("closures cannot be swapped")
    unresolved = sorted(
        name
        for name in _global_reads(swap)
        if name not in target.__globals__ and not hasattr(builtins, name)
    )
    reasons.extend(f"reads {name}, which {mutation.module} does not define" for name in unresolved)
    return reasons


def apply_mutation(mutation: GuardMutation) -> None:
    """Swap ``mutation``'s replacement into its guard, for every binding at once."""
    target = guard_function(mutation)
    reasons = unfit_reasons(mutation, target)
    if reasons:
        msg = f"{mutation.name}: " + "; ".join(reasons)
        raise GuardMutationError(msg)
    target.__code__ = mutation.replacement.__code__


def apply_named_mutation(name: str) -> None:
    """Apply the row of :data:`PRIVACY_GUARDS` called ``name``.

    Raises:
        GuardMutationError: no row has that name, or its replacement does not fit.
    """
    mutation = GUARDS_BY_NAME.get(name)
    if mutation is None:
        msg = f"{name!r} names no guard in PRIVACY_GUARDS"
        raise GuardMutationError(msg)
    apply_mutation(mutation)
