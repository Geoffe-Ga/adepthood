"""The gate that binds a configured Creek Vault to the one user it belongs to.

Adepthood reaches a vault with a single deployment-wide identity. There is no
per-user credential to present and no tenant field anywhere in the ratified
``/v1`` contract -- ingest and reflect both refuse unknown properties, and the
wheel read is parameterless -- so everything adepthood replicates lands in one
corpus, every reflection is grounded in that whole corpus, and the wheel is its
whole-corpus aggregate. Per-user scoping therefore cannot be built from this
side at all; it can only be *declined*, which is what this module does.

The binding is one environment variable naming one adepthood user
(:data:`OWNER_ENV_VAR`). That user reaches the configured vault; every other
user is served the local fallback, which is exactly the path a deployment with
no vault has always run on -- their entries never enter the corpus, so no
stranger's reflection can quote them, and nothing they are answered with is
drawn from it. Nothing about their experience degrades beyond what an
unconfigured deployment already offers: the local pipeline is the floor the
whole seam is built on.

Fail closed, and never raise. An unset or unreadable binding leaves the vault
nobody's, since the alternative -- picking a user -- would pick the wrong one.
And this runs as a per-request dependency, where a raise means the handler body
never executes: a mis-typed variable would turn every journal save into a 500
and cost the writer their entry. That is the loss the whole seam promises can
never happen for a vault's sake, so this degrades for the same reason and in the
same way :func:`~services.creek_vault_client.build_creek_vault_client` degrades
for a stale protocol selector.

Kept apart from :mod:`dependencies.ownership` deliberately. That module audits
denied cross-tenant *probes*: someone reached for a row that is not theirs and
was refused with a 403 or an enumeration-safe 404. Nothing of the sort happens
here. A non-owner asked for nothing they should not have, is refused nothing,
and is answered in full -- what they lose is an optional capability they were
never told about. Borrowing that vocabulary would file a routine capability
degrade as an access-control incident and put a blameless user in an audit log.
"""

from __future__ import annotations

import logging
import os
from typing import Annotated

from fastapi import Depends

from domain.creek_vault import CreekVaultClient, resolve_vault_owner
from routers.auth import get_current_user
from services.creek_vault_client import LocalFallbackCreekVaultClient, build_creek_vault_client
from services.creek_vault_telemetry import VaultTelemetryOutcome

logger = logging.getLogger(__name__)

# The variable naming the single adepthood user a configured vault belongs to,
# and the one naming the vault itself. Read at request time rather than captured
# at import, matching ``build_creek_vault_client``: a redeployed configuration
# takes effect on the next request instead of the next restart, and a test can
# set one without reloading a module.
OWNER_ENV_VAR = "CREEK_VAULT_OWNER_USER_ID"
_VAULT_URL_ENV_VAR = "CREEK_VAULT_URL"

# The two ways a configured vault ends up belonging to nobody, and the two static
# messages that say so. Both name the variable that fixes it, because a record
# describing only the symptom leaves an operator to rediscover which of a dozen
# ``CREEK_VAULT_*`` settings is missing. They are separate messages because they
# are separate news: nobody has set the binding yet, versus somebody set it to
# something that is not a user id -- the first is a step not taken, the second is
# a value to go and look at.
_UNSET_OWNER_EVENT = (
    "creek vault is configured but bound to no user; every user gets the local "
    "fallback -- set CREEK_VAULT_OWNER_USER_ID to the id of the user it belongs to"
)
_UNREADABLE_OWNER_EVENT = (
    "creek vault owner binding is not a user id; every user gets the local "
    "fallback -- set CREEK_VAULT_OWNER_USER_ID to the id of the user it belongs to"
)

# What the variable was found to be, in a closed vocabulary of this module's own
# words. The raw value is deliberately absent: it is whatever an operator typed,
# and a variable filled in by hand next to ``CREEK_VAULT_API_KEY`` is one paste
# away from being a credential. "Unreadable" is the whole of what a reader needs,
# and it is the most a record can safely say.
_BINDING_UNSET = "unset"
_BINDING_UNREADABLE = "unreadable"


def _log_unowned_vault(raw_owner: str | None) -> None:
    """Warn that a configured vault is inert for everybody, without echoing the value.

    Only ever called once the vault is known to be configured, which is the whole
    condition that makes this worth waking someone for: a deployment carrying a
    vault URL, a credential, and no owner is one variable away from working, and
    silence would leave an operator reading a vault-shaped configuration whose
    replication simply never happens.
    """
    unset = raw_owner is None or not raw_owner.strip()
    event = _UNSET_OWNER_EVENT if unset else _UNREADABLE_OWNER_EVENT
    binding = _BINDING_UNSET if unset else _BINDING_UNREADABLE
    logger.warning(event, extra={"env_var": OWNER_ENV_VAR, "binding": binding})


def get_creek_vault_client(
    current_user: Annotated[int, Depends(get_current_user)],
) -> CreekVaultClient:
    """Return the vault client this caller may hold: the real one only for its owner.

    The bound owner gets whatever
    :func:`~services.creek_vault_client.build_creek_vault_client` makes of the
    deployment's configuration. Everyone else -- and everyone, when the binding
    is missing or unreadable -- gets :class:`LocalFallbackCreekVaultClient`, so
    their writing never reaches the shared corpus and no answer of theirs is ever
    drawn from it.

    The two silent paths are counted apart, by whether a vault exists at all. A
    deployment with none keeps counting
    :attr:`~VaultTelemetryOutcome.FALLBACK_UNCONFIGURED`, exactly as it did
    before this gate existed; a user held back from a vault that *is* there
    counts :attr:`~VaultTelemetryOutcome.FALLBACK_NOT_OWNER`. Both are DEBUG,
    because neither is a fault -- one operator chose no vault, and the other is
    watching the binding do its job. Only the misconfiguration in between, a
    vault configured and inert for everyone, is worth a WARNING, and it is the
    only thing logged here.
    """
    raw_owner = os.getenv(OWNER_ENV_VAR)
    owner = resolve_vault_owner(raw_owner)
    # ``owner`` is ``None`` when the binding is missing or unreadable, and no
    # user id equals ``None``, so an unbound vault falls through to the fallback
    # for everybody without a branch of its own.
    if owner == current_user:
        return build_creek_vault_client()
    vault_configured = bool(os.getenv(_VAULT_URL_ENV_VAR, ""))
    if owner is None and vault_configured:
        _log_unowned_vault(raw_owner)
    return LocalFallbackCreekVaultClient(_degrade_outcome(vault_configured=vault_configured))


def _degrade_outcome(*, vault_configured: bool) -> VaultTelemetryOutcome:
    """Name a local-fallback degrade after what is actually true of the deployment.

    With a vault present, the user is being kept out of one that exists -- whether
    because it belongs to someone else or because it belongs to nobody yet -- and
    that is what :attr:`~VaultTelemetryOutcome.FALLBACK_NOT_OWNER` says. With no
    vault at all there is no owner to not be, so the honest label is the one this
    path has always carried, and every counter predating this gate keeps its
    meaning.
    """
    if vault_configured:
        return VaultTelemetryOutcome.FALLBACK_NOT_OWNER
    return VaultTelemetryOutcome.FALLBACK_UNCONFIGURED
