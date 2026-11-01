"""The e2e lane's classification helper reports a stored key's vendor and seal, never the key."""

from __future__ import annotations

import json
from collections.abc import Iterator

import pytest
from cryptography.fernet import Fernet
from sqlalchemy.ext.asyncio import AsyncSession

from models.vault_classification_key import VaultClassificationKey
from services import journal_encryption
from tests.e2e.keyed_classification import inspect_run
from tests.helpers.feedback_triage import make_account

#: A synthetic, well-formed lane key; nothing ever spends it.
_LANE_KEY = "sk-ant-api03-lane3647helperCANARYzzzzzzzz"  # pragma: allowlist secret


@pytest.fixture
def _encrypted(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Configure a throwaway at-rest key, as the lane's server and helpers share one."""
    monkeypatch.setenv(journal_encryption.KEYS_ENV_VAR, Fernet.generate_key().decode())
    journal_encryption.reset_cache()
    yield
    journal_encryption.reset_cache()


@pytest.mark.asyncio
async def test_an_owner_with_no_stored_key_reports_none(db_session: AsyncSession) -> None:
    """No row reads as no vendor and no seal, beside the run state it already reported."""
    owner = await make_account(db_session, "e2e-keyless@example.com")

    state = await inspect_run(db_session, owner.email, arrange=False)

    assert state["stored_key_vendor"] is None
    assert state["stored_key_sealed"] is None


@pytest.mark.asyncio
@pytest.mark.usefixtures("_encrypted")
async def test_a_stored_key_reports_its_vendor_and_seal_only(db_session: AsyncSession) -> None:
    """The owner's row is named by vendor and ciphertext; a bystander's row is not read."""
    owner = await make_account(db_session, "e2e-keyed@example.com")
    bystander = await make_account(db_session, "e2e-bystander-key@example.com")
    db_session.add(
        VaultClassificationKey(user_id=bystander.user_id, provider="openai", api_key=_LANE_KEY)
    )
    db_session.add(
        VaultClassificationKey(user_id=owner.user_id, provider="anthropic", api_key=_LANE_KEY)
    )
    await db_session.commit()

    state = await inspect_run(db_session, owner.email, arrange=False)

    assert state["stored_key_vendor"] == "anthropic"
    assert state["stored_key_sealed"] is True
    assert _LANE_KEY not in json.dumps(state)
