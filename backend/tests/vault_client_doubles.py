"""The half of :class:`CreekVaultClient` that vault test doubles never exercise.

A test double for the vault seam is written to answer one capability
convincingly — a recording ingest, a scripted wheel, a reflection that escalates
— and to be structurally complete for the rest, because the protocol is what the
code under test is typed on. The uninteresting half is pure boilerplate, and
sixteen private copies of it is how a protocol becomes expensive to extend: a
method added to the seam is then a method added to sixteen classes, in sixteen
files, by hand.

So the boilerplate lives here once, and a double inherits it. Nothing in this
module answers anything a test would assert on: every method raises the same
:class:`CreekCapabilityUnsupportedError` the local-fallback client raises, which
is the honest answer for a double that was not built to serve the capability
being asked for. A test that finds one of these raising has discovered that the
code under test reached a capability the double never claimed — which is worth
knowing, and is why these refuse rather than return a plausible empty value.

Not named ``test_*``, so pytest collects nothing from it — the
``creek_bundle_facts`` precedent in this directory.
"""

from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from domain.creek_vault import (
    CreekCapabilityUnsupportedError,
    VaultClassificationPass,
    VaultJournalWithdrawResult,
    VaultLinkPass,
    VaultLinkStage,
    VaultPipelineJob,
)
from routers import journal as journal_router

_UNSERVED = "this vault double does not serve the batch pipeline"


class NoPipelineVaultDouble:
    """A base for vault doubles that are not exercising the batch pipeline.

    Inherited rather than copied, so the two whole-vault pipeline calls are
    written once for every double that has no opinion about them. A double that
    *does* exercise the pipeline overrides them, exactly as it would if it had
    declared them itself.
    """

    async def withdraw_journal_entry(self, _entry_id: int, /) -> VaultJournalWithdrawResult:
        """Raise: this double was not built to withdraw a journal entry."""
        raise CreekCapabilityUnsupportedError(_UNSERVED)

    async def classify_corpus(self) -> VaultClassificationPass | VaultPipelineJob:
        """Raise: this double was not built to run a classification pass.

        Typed at the seam's own union rather than at the narrower half this
        base returns, so a subclass that *does* exercise the durable-job branch
        can override it without widening a return type.
        """
        raise CreekCapabilityUnsupportedError(_UNSERVED)

    async def link_corpus(self, _stage: VaultLinkStage, /) -> VaultLinkPass | VaultPipelineJob:
        """Raise: this double was not built to run a linker stage.

        Typed at the seam's own union, for the reason :meth:`classify_corpus`
        is.
        """
        raise CreekCapabilityUnsupportedError(_UNSERVED)


#: The opaque fingerprint :func:`bind_every_account_to_a_recorded_vault` answers.
RECORDED_VAULT = "d" * 32


def bind_every_account_to_a_recorded_vault(monkeypatch: pytest.MonkeyPatch) -> str:
    """Make the journal router resolve every account's vault to :data:`RECORDED_VAULT`.

    In production a dialable vault client always comes from a recorded vault.
    A test that serves a scripted double without storing a connection would
    otherwise send every copy with no recorded destination -- exactly a
    pre-binding copy, which no vault may ever confirm withdrawn (#3095).
    """

    async def _recorded(_session: AsyncSession, _user_id: int) -> str:
        return RECORDED_VAULT

    monkeypatch.setattr(journal_router, "resolved_vault_destination", _recorded)
    return RECORDED_VAULT
