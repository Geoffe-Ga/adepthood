"""Which Creek Vault, if any, this request's caller may reach.

Two questions look alike here and are not the same, and confusing them is what
made this module's own docstring argue, at length, that the feature it now
implements could not be built. They are worth separating before anything else:

* **Partitioning one shared vault by user.** Not buildable from this side, and
  the reasoning is unchanged: there is no tenant field anywhere in the ratified
  ``/v1`` contract -- ingest and reflect both refuse unknown properties, and the
  wheel read is parameterless -- so adepthood has no way to label whose fragment
  is whose inside one corpus, and Creek publishes no partitioning guarantee to
  lean on instead (ADR 0004 Decision 7(a)). Nothing below attempts it.
* **Per-user vault *instances*.** What this module does. Each user connects a
  vault that is already theirs alone and supplies the credential that opens it,
  so there is nothing to disambiguate: one vault, one owner, which is the
  contract's own assumption. No tenant field is needed because no request ever
  has to say which of several tenants is asking.

An earlier version of this docstring stated the first and drew a conclusion
about the second -- that per-user scoping "cannot be built from this side at
all; it can only be *declined*". That was wrong, and it was the kind of wrong
that propagates: it read as a settled finding, and the next reader had every
reason to close the work rather than do it.

So: resolution runs in two steps, most specific first.

**The user's own connection.** A row in ``uservaultconfig`` naming a URL and
holding an encrypted credential. If one exists, that is the vault this caller
reaches, whatever the deployment's environment says -- a user who has connected
their own vault must never be handed somebody else's corpus because an operator
also set a deployment-wide default. The credential is decrypted on the way out
of the column and handed straight to the adapter; it is not logged, not put in
an exception, and not carried on any response body (see
:mod:`schemas.vault_config`).

**The deployment-wide default.** Unchanged, and kept for one release so an
operator can migrate their users before the environment path is retired:
:data:`OWNER_ENV_VAR` names the one adepthood user a configured
``CREEK_VAULT_URL`` belongs to. That user reaches it; every other user who has
connected nothing of their own gets the local fallback. This is the
single-corpus binding ADR 0004 Decision 7(b) describes, and it is exactly as
narrow as it always was -- one vault, one user -- which is precisely why the
per-user path above exists.

**The floor.** Everybody else gets :class:`LocalFallbackCreekVaultClient`, the
same path a deployment with no vault has always run on. Their entries never
enter anyone's corpus, no stranger's reflection can quote them, and nothing they
are answered with is drawn from one. Nothing about their experience degrades
beyond what an unconfigured deployment already offers: the local pipeline is the
floor the whole seam is built on.

Fail closed, and never raise. An unset or unreadable deployment binding leaves
that vault nobody's, since the alternative -- picking a user -- would pick the
wrong one. And this runs as a per-request dependency, where a raise means the
handler body never executes: a mis-typed variable, or a stored URL that stopped
being usable, would turn every journal save into a 500 and cost the writer their
entry. That is the loss the whole seam promises can never happen for a vault's
sake, so both degrade for the same reason and in the same way
:func:`~services.creek_vault_client.build_creek_vault_client` degrades for a
stale protocol selector.

Kept apart from :mod:`dependencies.ownership` deliberately. That module audits
denied cross-tenant *probes*: someone reached for a row that is not theirs and
was refused with a 403 or an enumeration-safe 404. Nothing of the sort happens
here. A user without a vault asked for nothing they should not have, is refused
nothing, and is answered in full -- what they lack is an optional capability
they were never told about. Borrowing that vocabulary would file a routine
capability degrade as an access-control incident and put a blameless user in an
audit log.
"""

from __future__ import annotations

import logging
import os
from typing import Annotated

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_session
from domain.creek_vault import CreekVaultClient, resolve_vault_owner
from routers.auth import get_current_user
from services.creek_vault_client import (
    LocalFallbackCreekVaultClient,
    build_connected_vault_client,
    build_creek_vault_client,
)
from services.creek_vault_telemetry import VaultTelemetryOutcome
from services.user_vault_config import load_vault_config

logger = logging.getLogger(__name__)

# The variable naming the single adepthood user the *deployment-wide* vault
# belongs to, and the one naming that vault itself. Read at request time rather
# than captured at import, matching ``build_creek_vault_client``: a redeployed
# configuration takes effect on the next request instead of the next restart,
# and a test can set one without reloading a module.
#
# Both are the pre-per-user path, kept for one release so an operator can move
# their users onto their own connections before the binding is retired. A user
# who has connected a vault of their own never reaches either of them.
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


def deployment_vault_client(current_user: int) -> CreekVaultClient:
    """Return the deployment-wide vault, for a caller who connected none of their own.

    The pre-per-user path, unchanged in behaviour and kept for one release. The
    bound owner gets whatever
    :func:`~services.creek_vault_client.build_creek_vault_client` makes of the
    deployment's configuration. Everyone else -- and everyone, when the binding
    is missing or unreadable -- gets :class:`LocalFallbackCreekVaultClient`, so
    their writing never reaches that one shared corpus and no answer of theirs is
    ever drawn from it.

    Public rather than private because it is the whole of the environment path:
    it can be exercised against an environment on its own, without a database
    and without a request, which is how the binding's fail-closed rules are
    pinned.

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


async def get_creek_vault_client(
    current_user: Annotated[int, Depends(get_current_user)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> CreekVaultClient:
    """Return the vault client this caller may hold: their own, or the deployment's, or none.

    The caller's own connection is looked for first and wins outright. That
    ordering is the security property, not a preference: an operator's
    deployment-wide default and a user's own vault are two different corpora,
    and resolving them the other way round would hand a user who deliberately
    connected their own vault the shared one instead.

    One lookup per request, on the session the handler is already using, so this
    adds a single indexed read by ``user_id`` rather than a connection of its
    own.
    """
    connection = await load_vault_config(session, current_user)
    if connection is not None:
        return build_connected_vault_client(connection.vault_url, connection.api_key)
    return deployment_vault_client(current_user)


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
