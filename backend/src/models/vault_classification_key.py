"""A writer's own provider key, kept encrypted so their vault can sort writing later (R1-1).

Owner decision R1-1 (2026-10-27), with the split the owner confirmed on
2026-11-01: an account that has **not** enrolled in user-held keys may have its
BYOK key stored here, so the classification the vault runs after the request
that carried the key -- a detached continuation, a bounded retry, restart
recovery, a later save from a device that sent no key -- can still use it.
ADR 0009's "Amendment 2026-11-01" is the record; Creek-Vault ADR-0015's
amendment of the same date is the vault's half.

Everything about the row follows from the key being a live third-party secret
that the server can decrypt:

* ``api_key`` is :class:`~services.journal_encryption.EncryptedString`, the
  facility every other secret at rest here uses (``uservaultconfig.api_key``
  among them). The service refuses to write one at all while encryption is not
  configured, so the column never holds plaintext.
* The scope is vault classification only. Nothing but the pipeline's
  classification submit reads it (:mod:`services.vault_classification_key`);
  reflections and letters still run on the key the request carries.
* It is never returned, exported, logged or rendered. No response schema
  carries it, the data export omits the table, and :class:`ProseRedactingRepr`
  redacts the column from every rendering of the row.
* ``user_id`` is unique, so a replaced key overwrites rather than accumulates,
  and the row goes with the account (``ON DELETE CASCADE`` and the deletion
  policy both).

This is **not operator-blind**: the operator holds the encryption key, so the
operator can technically decrypt this column. An enrolled account keeps its key
user-held instead and has no row here; enrolment deletes it.
"""

from sqlalchemy import CheckConstraint, Column
from sqlmodel import Field, SQLModel

from models._prose_repr import ProseRedactingRepr
from services.journal_encryption import EncryptedString

#: The vendors a vault may be handed a writer's key for; mirrors
#: :class:`~domain.creek_vault.VaultKeyProvider`, which a drift test pins.
STORED_KEY_PROVIDERS: tuple[str, ...] = ("anthropic", "openai")

_PROVIDER_WIDTH = 16


def _quoted(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


class VaultClassificationKey(ProseRedactingRepr, SQLModel, table=True):
    """One account's stored provider key, for its vault's background classification.

    Attributes:
        user_id: The account the key belongs to; one row per account.
        provider: The key's vendor, from a closed vocabulary.
        api_key: The key itself, encrypted at rest.
    """

    __tablename__ = "vaultclassificationkey"
    __table_args__ = (
        CheckConstraint(
            f"provider IN ({_quoted(STORED_KEY_PROVIDERS)})",
            name="ck_vaultclassificationkey_provider_valid",
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", unique=True, ondelete="CASCADE")
    provider: str = Field(max_length=_PROVIDER_WIDTH)
    api_key: str = Field(sa_column=Column(EncryptedString(), nullable=False))
