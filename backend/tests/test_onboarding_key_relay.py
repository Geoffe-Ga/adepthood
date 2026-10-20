"""The writer's key on a document import and a journal save, at the HTTP edge (#3437).

``POST /corpus/import`` and ``POST /journal/`` hand a vault new writing, and
the classification pass that onboards it is the one call of theirs that may
carry the writer's own key: never the upload or the journal upsert. Driven
through the real HTTP adapter against a scripted managed vault, so the headers
asserted are the ones a socket would have carried.
"""

from __future__ import annotations

import base64
import json
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass, field
from http import HTTPStatus
from typing import Final

import pytest
import pytest_asyncio
from httpx import AsyncClient, MockTransport, Request, Response

from dependencies.creek_vault import get_creek_vault_client
from domain.creek_vault import CONTRACT_VERSION
from main import app
from services.creek_vault_client import HttpCreekVaultClient
from services.creek_vault_pipeline import wait_for_vault_pipeline_tasks
from services.creek_vault_relay import PROVIDER_KEY_HEADER
from tests.provider_transport import ANTHROPIC_KEY

_PASSWORD: Final = "secret12345"  # pragma: allowlist secret
_BYOK_HEADER: Final = "X-LLM-API-Key"
_CLASSIFICATIONS: Final = "/v1/classifications"
_UPLOADS: Final = "/v1/uploads"
_JOURNAL_ENTRIES: Final = "/v1/journal-entries/"
_MINOR: Final = ".".join(CONTRACT_VERSION.split(".")[:2])


def _counts(**extra: object) -> dict[str, object]:
    return {"status": "ok", "tier_ceiling": "personal", **extra}


_CLASSIFIED: Final = _counts(
    method="llm",
    total=1,
    classified=1,
    preserved_manual=0,
    preserved_llm=0,
    privacy_tiers_assigned=0,
    retiered=0,
    praxis_marked=0,
    tags_extracted=1,
    complete=True,
)


def _linked(method: str) -> dict[str, object]:
    return _counts(
        method=method,
        fragment_count=1,
        link_count=1,
        largest_cluster_fragments=1,
        clusters_split=0,
        oversized_discarded=0,
    )


@dataclass
class _ManagedVault:
    """A managed vault that spends Anthropic and OpenAI keys, recording each send's key."""

    sends: list[tuple[str, str | None]] = field(default_factory=list)

    def keyed(self) -> list[str]:
        """The paths of every send that carried a writer's key."""
        return [path for path, key in self.sends if key is not None]

    def paths(self) -> list[str]:
        """The paths of every send, keyed or not."""
        return [path for path, _key in self.sends]

    def __call__(self, request: Request) -> Response:
        path = request.url.path
        self.sends.append((path, request.headers.get(PROVIDER_KEY_HEADER)))
        return Response(HTTPStatus.OK, json=self._answer(path, request))

    def _answer(self, path: str, request: Request) -> Mapping[str, object]:
        if path == "/v1/capabilities":
            return {
                "vault": {"available": True},
                "capabilities": ["capabilities", "journal-upsert", "upload", "pipeline"],
                "contract_version": CONTRACT_VERSION,
                "contract_minor": _MINOR,
                "supported_contract_minors": [_MINOR],
                "request_key_providers": ["anthropic", "openai"],
                "ontology_version": "1.0.0",
                "attestation": None,
            }
        if path == _UPLOADS:
            external_id = json.loads(request.content)["external_id"]
            return {
                "status": "ok",
                "action": "created",
                "external_id": external_id,
                "fragment_id": "frag-document-1",
                "affected_fragment_ids": ["frag-document-1"],
                "source_type": "document",
                "tier_ceiling": "personal",
            }
        if path.startswith(_JOURNAL_ENTRIES):
            tier = json.loads(request.content)["tier"]
            return {
                "status": "ok",
                "action": "created",
                "external_id": path.removeprefix(_JOURNAL_ENTRIES),
                "fragment_id": "frag-journal-1",
                "tier": tier,
                "tier_ceiling": "personal",
            }
        if path == _CLASSIFICATIONS:
            return _CLASSIFIED
        return _linked(str(json.loads(request.content)["method"]))


@pytest_asyncio.fixture
async def managed_vault() -> AsyncIterator[_ManagedVault]:
    """Install a real HTTP vault client, over a scripted managed vault, for one test."""
    script = _ManagedVault()
    async with AsyncClient(transport=MockTransport(script)) as http:
        client = HttpCreekVaultClient(
            "https://vault.example.test", "vault-key", http_client=http, pin_destination=False
        )
        app.dependency_overrides[get_creek_vault_client] = lambda: client
        try:
            yield script
            await wait_for_vault_pipeline_tasks()
        finally:
            app.dependency_overrides.pop(get_creek_vault_client, None)


async def _signup(client: AsyncClient, username: str) -> dict[str, str]:
    response = await client.post(
        "/auth/signup", json={"email": f"{username}@example.com", "password": _PASSWORD}
    )
    assert response.status_code == HTTPStatus.OK
    return {"Authorization": f"Bearer {response.json()['token']}"}


def _document() -> dict[str, str]:
    return {
        "filename": "field-notes.md",
        "content_base64": base64.b64encode(b"the willow bent").decode("ascii"),
        "classification": "personal",
    }


@pytest.mark.asyncio
async def test_an_import_relays_the_key_to_classification_and_never_to_the_upload(
    async_client: AsyncClient, managed_vault: _ManagedVault
) -> None:
    """The import's own classification pass is keyed; the document's upload is not."""
    headers = await _signup(async_client, "import_relay")

    response = await async_client.post(
        "/corpus/import", json=_document(), headers={**headers, _BYOK_HEADER: ANTHROPIC_KEY}
    )
    await wait_for_vault_pipeline_tasks()

    assert response.status_code == HTTPStatus.ACCEPTED, response.text
    assert _UPLOADS in managed_vault.paths(), managed_vault.sends
    assert managed_vault.keyed() == [_CLASSIFICATIONS], managed_vault.sends
    assert {key for _path, key in managed_vault.sends if key} == {ANTHROPIC_KEY}
    assert ANTHROPIC_KEY not in response.text
