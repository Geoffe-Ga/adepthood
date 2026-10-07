"""Stamp and report which side answered each AI operation, and who paid (#3062).

The receipts themselves are built in :mod:`services.marginalia` (from the
responses the app provider returned) and :mod:`services.creek_vault_reflect`
(for a vault that answered). This module is the narrow layer between them and
the two places a receipt ends up: the ``marginalia`` row, where it is stamped in
the same commit as the note or letter it describes, and the resonance response,
where the pass reports each operation's source and its payer.

Everything here is closed vocabulary, opaque ids and counts. A receipt never
carries a prompt, a body, a note, or a key, so the log fields built from one are
safe to hand an operator.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from models.marginalia import RECEIPT_VERSION, Marginalia, MarginaliaSource
from schemas.marginalia import OperationSource, PassProvenance, ProvenanceReceipt
from services.marginalia import InferenceReceipt, attempted_receipt

PaidBy = Literal["own_key", "wallet", "free"]


def is_demo(receipt: InferenceReceipt | None) -> bool:
    """Return whether ``receipt`` records the stub provider's canned answer."""
    return receipt is not None and receipt.source is MarginaliaSource.DEMO


def source_value(receipt: InferenceReceipt | None) -> str:
    """Return the operation-source word for a log line: the source, or ``none``."""
    return OperationSource.NONE.value if receipt is None else receipt.source.value


def stamp_note(row: Marginalia, receipt: InferenceReceipt | None) -> None:
    """Record on ``row`` which side answered its note.

    ``None`` leaves the columns unset, which reads back as "source not
    recorded" -- the honest value when no answer was observed.
    """
    if receipt is None:
        return
    row.source = receipt.source.value
    row.source_provider = None if receipt.provider is None else receipt.provider.value
    row.source_model = receipt.model
    row.receipt_version = RECEIPT_VERSION


def stamp_letter(row: Marginalia, receipt: InferenceReceipt | None) -> None:
    """Record on ``row`` which side answered its letter, beside the note's own source.

    ``receipt_version`` is left alone on a note whose own source was never
    recorded: a non-null version means the note's receipt exists, and a letter
    written later cannot supply it.
    """
    if receipt is None:
        return
    row.essay_source = receipt.source.value
    if row.source is not None:
        row.receipt_version = RECEIPT_VERSION


def detection_receipt(
    answered: InferenceReceipt | None, *, dialled: bool, api_key: str | None
) -> InferenceReceipt | None:
    """Return detection's receipt: what answered, else what was sent to, else ``None``.

    ``None`` -- rendered ``none`` -- is reserved for a check that never sent
    anything (no candidates, or a vault-bound caller). A call that went out and
    failed is the app provider's, with ``detection_checked`` false beside it.
    """
    if answered is not None:
        return answered
    return attempted_receipt(api_key) if dialled else None


def operation_receipt(receipt: InferenceReceipt | None) -> ProvenanceReceipt:
    """Render one operation's receipt for the response; ``None`` is an operation not run."""
    if receipt is None:
        return ProvenanceReceipt(source=OperationSource.NONE, receipt_version=RECEIPT_VERSION)
    return ProvenanceReceipt(
        source=OperationSource(receipt.source.value),
        provider=receipt.provider,
        model=receipt.model,
        receipt_version=RECEIPT_VERSION,
    )


@dataclass(frozen=True, slots=True)
class PassReceipts:
    """The receipts of one pass's two operations, and whether detection returned."""

    notes: InferenceReceipt | None
    detection: InferenceReceipt | None
    detection_checked: bool


def _app_provider_answered(receipts: PassReceipts) -> bool:
    """Whether any operation of the pass went to the app provider."""
    return any(
        receipt is not None and receipt.source is MarginaliaSource.APP_PROVIDER
        for receipt in (receipts.notes, receipts.detection)
    )


def paid_by(receipts: PassReceipts, *, byok: bool, charge_kept: bool) -> PaidBy:
    """Return who paid for a settled pass.

    A demo costs nobody anything. The caller's own key paid only when an
    app-provider operation actually used it -- the client attaches its key to
    every request, and a vault-bound pass never sends it anywhere. Otherwise
    the wallet when its deduction stood, or nobody when it was handed back or
    never taken.
    """
    if is_demo(receipts.notes):
        return "free"
    if byok and _app_provider_answered(receipts):
        return "own_key"
    return "wallet" if charge_kept else "free"


def pass_provenance(receipts: PassReceipts, *, byok: bool, charge_kept: bool) -> PassProvenance:
    """Build the response's pass-level provenance from what the pass observed."""
    return PassProvenance(
        notes=operation_receipt(receipts.notes),
        detection=operation_receipt(receipts.detection),
        detection_checked=receipts.detection_checked,
        paid_by=paid_by(receipts, byok=byok, charge_kept=charge_kept),
    )
