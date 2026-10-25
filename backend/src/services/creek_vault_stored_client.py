"""Build a stored vault's client after the caller has established ownership.

Both the ordinary owner resolver and optional agent discovery use this same
DNS admission and constructor. This module neither chooses an owner/default
nor changes the resolver's request-local destination context.
"""

from __future__ import annotations

import logging

from sqlalchemy.ext.asyncio import AsyncSession

from domain.creek_vault import CreekVaultPipelineClient
from services.creek_vault_client import LocalFallbackCreekVaultClient, build_connected_vault_client
from services.creek_vault_telemetry import VaultTelemetryOutcome
from services.creek_vault_url_resolution import classify_resolved_user_vault_url_off_the_pool
from services.creek_vault_url_user import vault_url_host

_LOGGER = logging.getLogger(__name__)
_FORBIDDEN_DESTINATION_EVENT = (
    "a connected creek vault host resolves to a destination this server must not dial; "
    "that user gets the local fallback -- they can reconnect their vault to fix it"
)


async def stored_host_is_undialable(session: AsyncSession, vault_url: str) -> bool:
    """Rejudge the host off the database pool, with value-free refusal telemetry."""
    finding = await classify_resolved_user_vault_url_off_the_pool(
        session, vault_url_host(vault_url)
    )
    if finding is None:
        return False
    _LOGGER.warning(
        _FORBIDDEN_DESTINATION_EVENT,
        extra={
            "config_source": "user_vault_connection",
            "url_defect": finding.defect.value,
            "url_detail": finding.detail,
        },
    )
    return True


async def build_stored_vault_client(
    session: AsyncSession, vault_url: str, api_key: str
) -> CreekVaultPipelineClient:
    """Apply shared dial-time admission to a binding the caller already owns."""
    if await stored_host_is_undialable(session, vault_url):
        return LocalFallbackCreekVaultClient(VaultTelemetryOutcome.FALLBACK_UNCONFIGURED)
    return build_connected_vault_client(vault_url, api_key)
