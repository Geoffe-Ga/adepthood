"""Best-effort mirroring of AI-authored Voice Drafts into Creek Vault.

Postgres remains the system of record. A generated essay gets one immediate,
capability-gated upsert into the writer's connected vault; a later intimate
reclassification gets one content-free delete. Neither operation is queued or
retried, and every Creek failure degrades after a content-free log record so a
vault can never cost the writer their local draft.

This is a dedicated capability rather than the document-upload path. Creek owns
the former's fixed ``ai-as-user`` attribution and zero voice weight; the latter
represents owner-supplied documents and would train the wrong voice.
"""

from __future__ import annotations

import hashlib
import logging

from domain.creek_vault import (
    CreekCapability,
    CreekVaultError,
    CreekVaultVoiceDraftClient,
    VaultTierCeiling,
    VaultVoiceDraftRequest,
    tier_ceiling_for,
)
from services.creek_vault_upload import _expressible_on_the_wire

_LOGGER = logging.getLogger(__name__)

_EXTERNAL_ID_PREFIX = "adepthood-voicedraft-"
_EXTERNAL_ID_DIGEST_CHARS = 32
_IDENTITY_SEPARATOR = "\x00"

_MIRROR_DEGRADED_EVENT = "creek vault voice draft mirror degraded"
_MIRROR_STORED_EVENT = "creek vault voice draft mirrored"
_RETRACTION_DEGRADED_EVENT = "creek vault voice draft retraction degraded"
_RETRACTED_EVENT = "creek vault voice draft retracted"


def voice_draft_external_id(owner_user_id: int, marginalia_id: int) -> str:
    """Return the stable opaque Creek key for one user's expanded marginalia.

    Both local ids are identities rather than prose, but hashing them still
    prevents a vault URL or access log from revealing account and row numbers.
    The NUL separator makes the pair unambiguous before hashing, and 128 digest
    bits are ample for a personal corpus while keeping the URL compact.
    """
    identity = f"{owner_user_id}{_IDENTITY_SEPARATOR}{marginalia_id}".encode()
    digest = hashlib.sha256(identity).hexdigest()[:_EXTERNAL_ID_DIGEST_CHARS]
    return f"{_EXTERNAL_ID_PREFIX}{digest}"


async def _supports_voice_drafts(client: CreekVaultVoiceDraftClient) -> bool:
    """Negotiate once and report whether this vault can store Voice Drafts."""
    handshake = await client.handshake()
    return handshake.available and client.supports(CreekCapability.VOICE_DRAFTS)


async def mirror_voice_draft(
    client: CreekVaultVoiceDraftClient,
    *,
    owner_user_id: int,
    marginalia_id: int,
    essay: str,
    classification: str,
) -> None:
    """Make one best-effort upsert of a non-intimate generated essay.

    The tier guard runs before the handshake so an intimate essay never reaches
    even a client method. An unavailable or unsupported vault is the ordinary
    local-only configuration and returns silently. Once admitted, exactly one
    upsert is attempted; a Creek fault or an unreadable success is recorded and
    dropped, never retried.
    """
    tier = tier_ceiling_for(classification)
    if not _expressible_on_the_wire(tier):
        return
    if not await _supports_voice_drafts(client):
        return

    external_id = voice_draft_external_id(owner_user_id, marginalia_id)
    request = VaultVoiceDraftRequest(
        external_id=external_id,
        content=essay,
        tier=tier,
        tier_ceiling=tier,
    )
    try:
        result = await client.upsert_voice_draft(request)
    except CreekVaultError:
        _LOGGER.warning(
            _MIRROR_DEGRADED_EVENT,
            extra={"external_id": external_id, "reason": "vault_error"},
        )
        return
    if not result.stored:
        _LOGGER.warning(
            _MIRROR_DEGRADED_EVENT,
            extra={"external_id": external_id, "reason": "not_stored"},
        )
        return
    _LOGGER.info(
        _MIRROR_STORED_EVENT,
        extra={"external_id": external_id, "action": result.action},
    )


async def retract_voice_draft(
    client: CreekVaultVoiceDraftClient,
    *,
    owner_user_id: int,
    marginalia_id: int,
) -> None:
    """Make one best-effort content-free retraction of a mirrored draft.

    ``PERSONAL`` is the widest ceiling the remote wire admits, so it can delete
    either an open or a personal copy. The local essay is intentionally absent
    from this signature: an intimate reclassification must not resend the prose
    it is retracting.
    """
    if not await _supports_voice_drafts(client):
        return
    external_id = voice_draft_external_id(owner_user_id, marginalia_id)
    try:
        result = await client.delete_voice_draft(
            external_id,
            VaultTierCeiling.PERSONAL,
        )
    except CreekVaultError:
        _LOGGER.warning(
            _RETRACTION_DEGRADED_EVENT,
            extra={"external_id": external_id, "reason": "vault_error"},
        )
        return
    if not result.deleted:
        _LOGGER.warning(
            _RETRACTION_DEGRADED_EVENT,
            extra={"external_id": external_id, "reason": "not_deleted"},
        )
        return
    _LOGGER.info(_RETRACTED_EVENT, extra={"external_id": external_id})
