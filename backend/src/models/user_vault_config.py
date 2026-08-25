"""One user's own Creek Vault: where it lives, and the credential that opens it.

This is the row that makes "you choose your depth" true of the vault as well.
Before it, a deployment reached one vault with one credential read out of its
environment, so at most one user could ever have vault-backed reflections and
everybody else ran the local pipeline. Here each user names a vault that is
already theirs alone, so a deployment can serve as many vaults as it has users
without adepthood ever having to ask Creek to keep two people apart inside one
corpus -- which the ratified ``/v1`` contract has no field to express, and which
this table therefore never needs.

Two columns, and they are not alike.

``vault_url`` is an endpoint. It is judged by
:func:`~services.creek_vault_url.classify_vault_url` before it is ever written,
by the same rules the deployment-wide variable is judged by, so a URL cannot be
accepted here and refused at request time. It is stored exactly as the user
wrote it: normalizing an operator's configuration into something they did not
type is the one thing this seam refuses to do, since a deployment replicating to
an endpoint subtly different from the configured one is worse than one
replicating nowhere and saying so.

``api_key`` is a **third-party secret at rest**, and everything about how it is
declared follows from that. It is :class:`~services.journal_encryption.EncryptedString`,
the same column type the journal body uses, rather than a second key scheme
invented for it. It is never returned by any endpoint -- there is no response
schema anywhere that carries it -- because a client that has just sent a
credential does not need it echoed and no client should ever be able to fetch
one. And it never reaches a log: the request-time degrade records name the
defect and the source of the configuration, never a value read out of this row.

``user_id`` is unique. One user has at most one vault, so reconnecting replaces
rather than accumulates, and there is no state in which two rows disagree about
where a user's writing goes.
"""

from typing import TYPE_CHECKING

from sqlalchemy import Column
from sqlmodel import Field, Relationship, SQLModel

from services.journal_encryption import EncryptedString

if TYPE_CHECKING:
    from .user import User

# Ceiling on the stored endpoint. Generous for a hostname plus a path prefix,
# and bounded because the value is untrusted input that is carried into a
# request builder. The request schema enforces the same ceiling, so an oversized
# URL is refused with a 422 rather than truncated by the column.
VAULT_URL_MAX_LENGTH = 2048


class UserVaultConfig(SQLModel, table=True):
    """The vault one user connected, and the credential that opens it.

    ``api_key`` carries no ``max_length``: it cannot coexist with ``sa_column``,
    and the ciphertext is longer than the plaintext anyway, so a column bound
    would be a bound on the wrong string. The ceiling that matters is enforced
    at the write boundary by
    :class:`~schemas.vault_config.VaultConnectionRequest`, which also refuses
    any credential an ``Authorization`` header could not carry.
    """

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", unique=True, ondelete="CASCADE")
    vault_url: str = Field(max_length=VAULT_URL_MAX_LENGTH)
    api_key: str = Field(sa_column=Column(EncryptedString(), nullable=False))
    user: "User" = Relationship(back_populates="vault_config")
