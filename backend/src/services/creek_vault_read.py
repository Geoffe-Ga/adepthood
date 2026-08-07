"""Observability for the Creek Vault read paths, which degrade in silence.

A read degrade is **invisible to the user by design**. Both read paths fall back
to something locally computed -- the wheel to the balance derived from the user's
own habits, practice, and course progress -- so a failed vault read looks exactly
like a healthy one from the outside. That is the right product behaviour and it
is also why this module exists: with nothing surfacing to a caller, a log record
is the *only* place an operator can see a read fail at all, or count how often it
does.

The fields are a closed vocabulary rather than redacted free text, for the same
reason the write path's are. Redaction is a promise that something was removed;
a closed vocabulary is a proof that it was never present. Every value written
here is either a :class:`~domain.creek_vault.CreekCapability` wire name, one of
this module's own :class:`VaultReadDegradeReason` members, or one of adepthood's
own :class:`~domain.creek_vault.VaultErrorCode` members -- so the entry body, the
credential, and any string a vault chose are absent by construction and there is
nothing here to forget to scrub.

Shaped after the observability block in :mod:`services.creek_vault_write` rather
than shared with it. The two vocabularies are wire contracts telemetry counts by,
and a read has a failure this write path cannot have (an unreadable payload) while
a write has one this read path cannot (a vault that answered yet stored nothing),
so merging them would mean a reason set that is wrong for both.
"""

from __future__ import annotations

import enum
import logging

from domain.creek_vault import (
    CreekCapability,
    CreekCapabilityUnsupportedError,
    CreekVaultAuthError,
    CreekVaultContractError,
    CreekVaultError,
    CreekVaultPayloadError,
    CreekVaultUnavailableError,
    VaultErrorCode,
)

_LOGGER = logging.getLogger(__name__)


class VaultReadDegradeReason(enum.StrEnum):
    """Why one vault read fell back to a locally-computed answer.

    The caller sees one silent fallback whichever of these happened -- that is
    the point of degrading -- so these exist purely to keep the failures
    countable *apart*, and each names a different owner: ``PAYLOAD`` is a vault
    bug to report upstream, ``CONTRACT`` is a defect in adepthood's own request,
    ``AUTH`` is a credential to rotate, ``UNSUPPORTED_CAPABILITY`` is a vault
    that never offered this read, and ``UNAVAILABLE`` is infrastructure to
    restore. Values are the wire strings telemetry counts by, so they are part
    of this module's contract and must not be reworded casually.
    """

    PAYLOAD = "payload"
    CONTRACT = "contract"
    AUTH = "auth"
    UNSUPPORTED_CAPABILITY = "unsupported_capability"
    UNAVAILABLE = "unavailable"


# The one static log event this module emits. Static because a vault error's own
# message can quote the entry body or the vault's own prose: everything variable
# travels in the structured ``extra`` fields instead, each of which is a wire
# name or one of our own enum values.
_DEGRADED_EVENT = "creek vault read degraded"


def _degrade_reason_for(error: CreekVaultError) -> VaultReadDegradeReason:
    """Attribute one vault error to the reason an operator would act on.

    Ordered most-specific first, and ``UNAVAILABLE`` is the catch-all rather
    than a match: a vault error type this module has not heard of is far more
    likely to be an availability fault than a contract one, and guessing
    "contract" would send someone hunting a bug in adepthood that is not there.

    :class:`~domain.creek_vault.CreekVaultPayloadError` is tested before
    :class:`~domain.creek_vault.CreekVaultContractError` deliberately. They are
    siblings today, so the order is not load-bearing today; it is written this
    way so that re-parenting one under the other later cannot silently
    reclassify every unreadable answer as a refused request.
    """
    if isinstance(error, CreekVaultPayloadError):
        return VaultReadDegradeReason.PAYLOAD
    if isinstance(error, CreekVaultContractError):
        return VaultReadDegradeReason.CONTRACT
    if isinstance(error, CreekVaultAuthError):
        return VaultReadDegradeReason.AUTH
    if isinstance(error, CreekCapabilityUnsupportedError):
        return VaultReadDegradeReason.UNSUPPORTED_CAPABILITY
    return VaultReadDegradeReason.UNAVAILABLE


def _error_code(error: CreekVaultError) -> VaultErrorCode | None:
    """Return the vault's own reason, but only when it is one of *our* members.

    The two error types that carry a code have already dropped anything the
    vault sent that adepthood does not recognize, so what survives here is
    always a member of a closed enum -- which is what makes it safe to write to
    a log record at all. Every other error type has no code to report.
    """
    if isinstance(error, CreekVaultContractError | CreekVaultUnavailableError):
        return error.code
    return None


def _degrade_fields(capability: CreekCapability, error: CreekVaultError) -> dict[str, object]:
    """Build the content-free structured fields describing why a read degraded."""
    fields: dict[str, object] = {
        "capability": capability.value,
        "reason": _degrade_reason_for(error).value,
    }
    code = _error_code(error)
    if code is not None:
        fields["code"] = code.value
    return fields


def log_read_degraded(capability: CreekCapability, error: CreekVaultError) -> None:
    """Record a fallen-back vault read at WARNING with a static message.

    The exception is deliberately neither formatted into the message nor passed
    as ``exc_info``: its text can quote the entry body or the vault's own prose,
    and this record is the one place either would otherwise escape. What an
    operator needs -- which capability, which reason, and the vault's own code
    when it named one we know -- is in the structured fields.
    """
    _LOGGER.warning(_DEGRADED_EVENT, extra=_degrade_fields(capability, error))
