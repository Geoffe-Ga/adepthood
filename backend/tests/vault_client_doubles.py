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

from domain.creek_vault import (
    CreekCapabilityUnsupportedError,
    VaultClassificationPass,
    VaultLinkPass,
    VaultLinkStage,
)

_UNSERVED = "this vault double does not serve the batch pipeline"


class NoPipelineVaultDouble:
    """A base for vault doubles that are not exercising the batch pipeline.

    Inherited rather than copied, so the two whole-vault pipeline calls are
    written once for every double that has no opinion about them. A double that
    *does* exercise the pipeline overrides them, exactly as it would if it had
    declared them itself.
    """

    async def classify_corpus(self) -> VaultClassificationPass:
        """Raise: this double was not built to run a classification pass."""
        raise CreekCapabilityUnsupportedError(_UNSERVED)

    async def link_corpus(self, _stage: VaultLinkStage, /) -> VaultLinkPass:
        """Raise: this double was not built to run a linker stage."""
        raise CreekCapabilityUnsupportedError(_UNSERVED)
