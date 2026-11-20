"""A vault's ``415 unsupported_source`` is the document's type, not a mishap (#3771).

Creek answers ``POST /v1/uploads`` with ``415 unsupported_source`` when a file is
not something it ingests as a document: a Substack ``posts.csv`` sent loose to a
caller declaring a contract minor before 0.33 is the live example, since Creek
keeps that manifest as metadata and can only express that as a ``202`` to newer
callers. Until #3771 the adapter dropped the code, read the 4xx as a contract
error and :func:`store_upload` answered ``degraded`` -- "we could not confirm,
send it again" -- which invited the person to resend a file the vault will turn
away every time, and counted it with the failures.

Pinned here, layer by layer:

- the adapter parses ``unsupported_source`` as one of its own codes;
- the service answers it ``unsupported_source``, never ``degraded``;
- the route answers ``202 {vault_status: "unsupported_source"}`` with a message
  that says nothing was stored and offers no retry.
"""

from __future__ import annotations

from http import HTTPStatus

import httpx
import pytest
from httpx import AsyncClient, MockTransport

from domain.creek_vault import (
    CreekVaultContractError,
    VaultErrorCode,
    VaultUploadStatus,
)
from schemas.journal_upload import UPLOAD_MESSAGES
from services.creek_vault_client import HttpCreekVaultClient
from services.creek_vault_upload import store_upload
from tests.test_document_upload_to_a_vault import ScriptedUploadClient
from tests.test_upload_vault_busy import (
    _busy_body,
    _BusyVault,
    _document,
    _import_against,
)

_UNSUPPORTED_SOURCE = "unsupported_source"
_VAULT_URL = "https://vault.example.test"
_VAULT_API_KEY = "creek-unsupported-source-key"  # pragma: allowlist secret


def _refusing_vault() -> _BusyVault:
    """A vault that answers every upload ``415 unsupported_source``, naming no wait."""
    return _BusyVault(
        busy_for=1,
        status=HTTPStatus.UNSUPPORTED_MEDIA_TYPE,
        body=_busy_body(_UNSUPPORTED_SOURCE),
        retry_after=None,
    )


class TestTheAdapterReadsTheCode:
    """``unsupported_source`` is parsed rather than dropped."""

    def test_the_code_is_one_of_adepthoods_own(self) -> None:
        """The wire string maps onto a member, so it survives the parse."""
        assert VaultErrorCode(_UNSUPPORTED_SOURCE) is VaultErrorCode.UNSUPPORTED_SOURCE

    @pytest.mark.asyncio
    async def test_a_415_upload_raises_a_coded_contract_error(self) -> None:
        """The refusal reaches the service carrying the code it was answered with."""
        async with httpx.AsyncClient(transport=MockTransport(_refusing_vault())) as http:
            client = HttpCreekVaultClient(
                _VAULT_URL, _VAULT_API_KEY, http_client=http, pin_destination=False
            )
            outcome = await store_upload(client, _document())
        assert outcome.status is VaultUploadStatus.UNSUPPORTED_SOURCE


class TestTheServiceAnswersTheTypeNotAMishap:
    """:func:`store_upload` keeps a refused type apart from ``degraded``."""

    @pytest.mark.asyncio
    async def test_a_coded_contract_error_is_unsupported_source(self) -> None:
        """Nothing was stored and no retry helps, so it is not ``degraded``."""
        error = CreekVaultContractError("refused", code=VaultErrorCode.UNSUPPORTED_SOURCE)
        outcome = await store_upload(ScriptedUploadClient(upload_error=error), _document())
        assert outcome.status is VaultUploadStatus.UNSUPPORTED_SOURCE
        assert outcome.vault_ref is None
        assert outcome.retry_after_seconds is None

    @pytest.mark.asyncio
    async def test_an_uncoded_contract_error_still_degrades(self) -> None:
        """Only the named code is a refused type; any other 4xx answers as before."""
        outcome = await store_upload(
            ScriptedUploadClient(upload_error=CreekVaultContractError("refused")), _document()
        )
        assert outcome.status is VaultUploadStatus.DEGRADED


class TestTheRouteAnswersTheRefusedType:
    """``POST /corpus/import`` says the vault does not take the file."""

    @pytest.mark.asyncio
    async def test_a_415_answers_unsupported_source(self, async_client: AsyncClient) -> None:
        """A 202 naming the refused type, nothing stored, no wait."""
        response = await _import_against(async_client, _refusing_vault(), "unsupported-415")
        body = response.json()
        assert response.status_code == HTTPStatus.ACCEPTED
        assert body["destination"] == "vault"
        assert body["vault_status"] == VaultUploadStatus.UNSUPPORTED_SOURCE.value
        assert body["stored"] is False
        assert body["vault_ref"] is None
        assert body["retry_after_seconds"] is None
        assert body["message"] == UPLOAD_MESSAGES[VaultUploadStatus.UNSUPPORTED_SOURCE]

    def test_the_message_says_nothing_was_stored_and_invites_no_resend(self) -> None:
        """Sending it again would be refused the same way, so it is not offered."""
        message = UPLOAD_MESSAGES[VaultUploadStatus.UNSUPPORTED_SOURCE].lower()
        assert "nothing was stored" in message
        assert "again" not in message
        assert "contact support" not in message
