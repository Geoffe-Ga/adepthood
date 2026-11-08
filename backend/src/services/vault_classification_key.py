"""The one place a writer's stored provider key is written, read and deleted (R1-1).

ADR 0009's "Amendment 2026-11-01": an **un-enrolled** account's BYOK key may be
kept server-decryptable, encrypted at rest, so the vault classification that
runs after the request that carried it -- the detached continuation, a bounded
retry, restart recovery, a save from a device that sent no key -- still runs on
the writer's own key instead of falling to the rules floor. An enrolled account
keeps its key user-held; nobody can enrol yet (enforced CSP plus SRI has not
shipped), and :func:`retire_on_enrolment` is what enrolment must call.

The lifecycle, every rule of which is here:

* **Retained** only when a classification admission relays the writer's key to
  a vault whose handshake advertises that vendor (``request_key_providers``),
  and only while at-rest encryption is configured -- a key is never written in
  plaintext. A different key replaces the stored copy on the spot.
* **Read** only by the pipeline's classification submit, for the account whose
  run it is, when the request itself carries no key.
* **Deleted** when the writer removes or replaces the key on their device
  (``DELETE /user/vault-classification-key``), when they disconnect their vault,
  when the vendor rejects it (Creek contract 0.26 ``request_key_rejected``), at
  enrolment, and with the account.

Nothing here logs, returns or renders the key. Log records name an event and
nothing else.
"""

from __future__ import annotations

import logging
from contextlib import AbstractContextManager, nullcontext
from typing import TYPE_CHECKING

from sqlalchemy import Text, type_coerce
from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import col, delete, select

from domain.creek_vault import (
    VaultJobFailureCode,
    VaultKeyProvider,
    VaultPipelineStage,
    VaultProviderKey,
)
from models.vault_classification_key import VaultClassificationKey
from services import journal_encryption
from services.creek_vault_relay import (
    forwarded_provider_key,
    forwarding_provider_key,
    has_forwarded_provider_key,
)

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from domain.creek_vault import CreekVaultPipelineClient

_LOGGER = logging.getLogger(__name__)


async def retain_forwarded_key(
    session: AsyncSession, client: CreekVaultPipelineClient, user_id: int
) -> None:
    """Store or replace the key this request relays, when the vault will spend it.

    Called at a keyed classification admission, with no transaction open. The
    handshake is read first so no pooled connection is held across it, then the
    row is upserted and committed. A refusal to store -- no key, no encryption,
    a vendor the vault does not advertise -- leaves any stored copy as it is.
    A database failure is logged without content and swallowed: retention is
    never a reason for a save or an import to fail.
    """
    key = forwarded_provider_key()
    if key is None or not journal_encryption.is_enabled():
        return
    handshake = await client.handshake()
    if not handshake.accepts_key(key.provider):
        return
    try:
        await _upsert(session, user_id, key)
    except SQLAlchemyError:
        await session.rollback()
        _LOGGER.warning("stored classification key was not retained")


async def _upsert(session: AsyncSession, user_id: int, key: VaultProviderKey) -> None:
    """Replace this account's row with ``key``, in one transaction.

    Delete-then-insert rather than read-compare-update, so an old copy is never
    decrypted to be compared -- one under a retired encryption key would
    otherwise refuse to be replaced -- and the stored ciphertext is always the
    current key's. The classification scheduler lock keeps admissions for one
    account serial; a lost race on the unique ``user_id`` is a database error
    the caller swallows.
    """
    await stage_forget(session, user_id)
    session.add(
        VaultClassificationKey(user_id=user_id, provider=key.provider.value, api_key=key.reveal())
    )
    await session.commit()


async def _stored_row(session: AsyncSession, user_id: int) -> tuple[str, str] | None:
    """This account's ``(provider, ciphertext)``, read past the codec.

    Columns, not an ORM entity, and the key column coerced to plain ``Text`` so
    nothing is decrypted during the fetch: a row under a retired encryption
    key then cannot raise inside the pipeline's own transaction, and nothing
    the session tracks is left holding the key.
    """
    result = await session.execute(
        select(
            col(VaultClassificationKey.provider),
            type_coerce(col(VaultClassificationKey.api_key), Text),
        ).where(col(VaultClassificationKey.user_id) == user_id)
    )
    row = result.first()
    return None if row is None else (str(row[0]), str(row[1]))


async def stored_classification_key(session: AsyncSession, user_id: int) -> VaultProviderKey | None:
    """This account's stored key, bound to its vendor, or ``None``.

    ``None`` also when the row cannot be decrypted (a retired encryption key)
    or names a vendor this build does not know: the submit then goes keyless,
    exactly as it did before any key was stored, and the next keyed admission
    replaces the row.
    """
    stored = await _stored_row(session, user_id)
    if stored is None:
        return None
    vendor, ciphertext = stored
    known = {provider.value: provider for provider in VaultKeyProvider}
    provider = known.get(vendor)
    if provider is None:
        return None
    try:
        secret = journal_encryption.decrypt(ciphertext)
    except journal_encryption.JournalEncryptionError:
        _LOGGER.warning("stored classification key could not be decrypted")
        return None
    return VaultProviderKey(provider=provider, _secret=secret)


async def classification_submit_key(
    session: AsyncSession,
    client: CreekVaultPipelineClient,
    user_id: int,
    stage: VaultPipelineStage,
) -> VaultProviderKey | None:
    """The stored key a classification submit relays when its request carries none.

    The pipeline's one admission point asks this before every send. A request
    that relays the writer's key keeps relaying it, and retains it for later
    (:func:`retain_forwarded_key`). Any other classification submit -- a
    keyless save, a detached retry, a queued successor, restart recovery --
    reads the account's own stored copy, keyed on the run's ``user_id``. The
    read is committed before the send so no pooled connection rides it. Every
    other stage spends no key.
    """
    if stage is not VaultPipelineStage.CLASSIFY:
        return None
    if has_forwarded_provider_key():
        await retain_forwarded_key(session, client, user_id)
        return None
    key = await stored_classification_key(session, user_id)
    await session.commit()
    return key


def relaying(stored: VaultProviderKey | None) -> AbstractContextManager[None]:
    """Relay ``stored`` on the sends inside the block, or leave the context as it is.

    ``None`` must not enter :func:`forwarding_provider_key`, which would clear a
    key the request itself is relaying. The vault client still decides at send
    time, from the vault's handshake, whether the key leaves at all.
    """
    return nullcontext() if stored is None else forwarding_provider_key(stored)


async def stage_forget(session: AsyncSession, user_id: int) -> None:
    """Delete this account's stored key inside the caller's transaction."""
    await session.execute(
        delete(VaultClassificationKey).where(col(VaultClassificationKey.user_id) == user_id)
    )


async def forget_if_rejected(
    session: AsyncSession, user_id: int, failure_code: VaultJobFailureCode | None
) -> None:
    """Delete the stored copy, in the landing run's transaction, when its vendor refused a key.

    Creek contract 0.26's ``request_key_rejected`` is final (#3600): the run
    lands ``failed`` and is not re-admitted. The same refusal would meet every
    later background submit, so the copy goes with it and is never spent again.
    No other reason forgets it: Creek 0.29's ``busy`` means the pass never got
    the vault's lock, let alone reached the vendor, and is retried with the
    same copy.
    """
    if failure_code is VaultJobFailureCode.REQUEST_KEY_REJECTED:
        await stage_forget(session, user_id)


async def forget_classification_key(session: AsyncSession, user_id: int) -> None:
    """Delete this account's stored key now. Idempotent: no row is the state asked for."""
    await stage_forget(session, user_id)
    await session.commit()


async def retire_on_enrolment(session: AsyncSession, user_id: int) -> None:
    """Delete the server-readable copy at the moment an account enrols in user-held keys.

    An enrolled account's key is kept encrypted under the user-held key (ADR
    0009 Decision item 13), which the server cannot read, so no server-readable
    copy may survive the enrolment. Phase (b)'s enrolment step calls this in the
    same transaction-ordered step that records the enrolment; nothing can enrol
    today.
    """
    await forget_classification_key(session, user_id)
    _LOGGER.info("stored classification key retired at enrolment")
