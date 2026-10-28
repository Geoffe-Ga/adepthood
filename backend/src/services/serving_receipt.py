"""Build the operator-only serving receipt that binds a live run to a build (#2871).

A deploy reviewer needs to know *which* build answered while a pilot run was
recorded, and what privacy-relevant state it was in. The receipt answers that
with a closed, content-free set of fields: the platform's exact git SHA, the
content pin, the egress-barrier and managed-rollout *states*, the pinned Creek
contract, and the custody vocabulary.

It is deliberately conservative. ``release`` is read only from the platform's
commit SHA and must be a full lowercase SHA -- ``SENTRY_RELEASE`` is a
free-form operator label and is never served as one. ``attested_confidential``
and ``local_model`` are fixed at the only values the code can back: nothing
attests an ordinary Fly allocation, and no model digest or inference probe
exists yet (B05/B07). No outbound client is called here; every value is read
from the process's own settings.
"""

from __future__ import annotations

import os
import re
from typing import Final

from sqlalchemy.ext.asyncio import AsyncSession

from domain.creek_vault import CONTRACT_VERSION
from models.vault_activation import VaultCustodyMode
from schemas.admin import ServingReceipt
from sentry import PLATFORM_RELEASE_ENV_VAR, UNKNOWN_RELEASE
from services.account_egress_barrier import rollout_for
from services.content_repository import content_version_info
from services.managed_vault_rollout import load_managed_vault_rollout

RECEIPT_SCHEMA: Final = 1
LOCAL_MODEL_UNKNOWN: Final = "unknown"
#: What ``/health`` reports when no content stamp is vendored; kept identical.
NO_CONTENT_PIN: Final = "none"
_CONTENT_SHA_KEY: Final = "sha"
_GIT_SHA_RE: Final = re.compile(r"[0-9a-f]{40}")

SERVING_RECEIPT_FIELDS: Final[frozenset[str]] = frozenset(
    {
        "receipt_schema",
        "release",
        "content_version",
        "egress_barrier",
        "managed_vault_rollout",
        "creek_contract_version",
        "custody_modes_supported",
        "attested_confidential",
        "local_model",
    }
)


def served_release() -> str:
    """Return the platform's exact commit SHA, or ``unknown``.

    Only :data:`sentry.PLATFORM_RELEASE_ENV_VAR` is consulted, and only a full
    lowercase 40-hex SHA is accepted, so an operator label or a truncated value
    can never be mistaken for the commit a pilot record binds to.
    """
    raw = os.getenv(PLATFORM_RELEASE_ENV_VAR, "")
    return raw if _GIT_SHA_RE.fullmatch(raw) else UNKNOWN_RELEASE


def build_serving_receipt(session: AsyncSession) -> ServingReceipt:
    """Read the closed receipt fields from this process's own settings."""
    return ServingReceipt(
        receipt_schema=RECEIPT_SCHEMA,
        release=served_release(),
        content_version=(content_version_info() or {}).get(_CONTENT_SHA_KEY, NO_CONTENT_PIN),
        egress_barrier=rollout_for(session).state,
        managed_vault_rollout=load_managed_vault_rollout().state,
        creek_contract_version=CONTRACT_VERSION,
        custody_modes_supported=sorted(VaultCustodyMode),
        attested_confidential=False,
        local_model=LOCAL_MODEL_UNKNOWN,
    )
