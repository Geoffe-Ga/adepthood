"""``GET /vault/agents/activity``: what agents asked a person's vault for (#3535).

Settings, under "Agents that may read your vault", lists the vault's recent calls
-- who, what, when and whether -- read through to Creek's 0.22
``GET /v1/agent-activity``. Each test drives the real route against a real
:class:`~services.creek_vault_client.HttpCreekVaultClient` whose only transport
is a scripted Creek, so the adapter's strict parse and the route's
re-projection are exercised together.

Three promises are pinned here:

* **Four fields out, whatever comes in.** A row is ``{agent, tool_label, at,
  outcome}`` in adepthood's own words. Creek's ``consumer`` is never echoed:
  it is matched against stamps this account owns and otherwise named
  generically, and an unknown tool is "Other". An answer carrying anything
  beyond the published four fields is refused whole.
* **Truthful attribution.** Creek stamps a JWT agent's calls with the
  agent's ``client_id`` (Creek-Vault#1976); calls stamped before that carry
  ``sub``, which names the person. A stamp is named after an agent only when it *is* one of this
  account's grant client ids; the person's own ``sub`` says only what it can.
* **A vault that cannot answer is "unavailable", never an error page.**
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Mapping
from http import HTTPStatus
from pathlib import Path
from typing import Final

import httpx
import pytest
from httpx import AsyncClient, Response
from sqlalchemy.ext.asyncio import AsyncSession

from dependencies.creek_vault import get_creek_vault_client
from domain.creek_vault import CreekVaultPipelineClient
from main import app
from models.vault_activation import VaultActivation, VaultActivationState
from routers.auth import session_signing_secret
from services import oauth_signing_keys
from services.creek_vault_client import HttpCreekVaultClient, LocalFallbackCreekVaultClient
from services.oauth_authorization import OAUTH_ISSUER_ENV_VAR
from services.oauth_consent_copy import CONSENT_UNNAMED_AGENT
from services.oauth_tokens import derived_subject
from services.user_vault_config import store_vault_config
from services.vault_agent_activity_copy import (
    ACTIVITY_ADEPTHOOD,
    ACTIVITY_ADEPTHOOD_OR_AN_AGENT,
    ACTIVITY_ONE_OF_YOUR_AGENTS,
    ACTIVITY_OTHER_TOOL,
    ACTIVITY_SOMETHING_ELSE,
    ACTIVITY_STOPPED_AGENT,
    TOOL_LABELS,
)
from tests.helpers.oauth import (
    ISSUER,
    VAULT_KEY,
    approve,
    connect_vault,
    install_signing_keys,
    register_agent,
    signup,
    vault_url_for,
)
from tests.helpers.openapi_errors import declared_response_schema, live_document, response_validator

_ACTIVITY: Final = "/vault/agents/activity"
_BUNDLE: Final = Path(__file__).parent.parent / "fixtures" / "creek_v1"
_CAPABILITIES_PATH: Final = "/v1/capabilities"
_CREEK_ACTIVITY_PATH: Final = "/v1/agent-activity"
_ROW_KEYS: Final = frozenset({"agent", "tool_label", "at", "outcome"})
_PROSE: Final = "SENTINEL_ROUTE_PROSE draft me an essay on the long way home"
_MANAGED_IDENTITY: Final = "adepthood-user-activity-managed"
_DEFAULT_LIMIT: Final = 50
_SETTINGS_LIMIT: Final = 20
_OVERLONG_LIMIT: Final = 2


@pytest.fixture(autouse=True)
def _issuer_and_keys(monkeypatch: pytest.MonkeyPatch) -> object:
    """Approving an agent needs an issuer and a signing key."""
    monkeypatch.setenv(OAUTH_ISSUER_ENV_VAR, ISSUER)
    install_signing_keys(monkeypatch)
    yield
    oauth_signing_keys.reset_cache()


def _read(relative: str) -> dict[str, object]:
    """Return one vendored JSON document."""
    document = json.loads((_BUNDLE / relative).read_bytes())
    assert isinstance(document, dict)
    return document


def _row(consumer: str, tool: str, at: str, outcome: str = "admitted") -> dict[str, object]:
    """One published ``AgentActivityRow``."""
    return {"consumer": consumer, "tool": tool, "at": at, "outcome": outcome}


def _answer(rows: list[dict[str, object]]) -> dict[str, object]:
    """One published ``AgentActivityResponse`` carrying *rows*."""
    return {"status": "ok", "tier_ceiling": "open", "skipped": 0, "rows": rows}


class _Creek:
    """A scripted Creek: the published 0.22 handshake, then one activity answer."""

    def __init__(
        self,
        body: object,
        *,
        status: int = HTTPStatus.OK,
        handshake: Mapping[str, object] | None = None,
    ) -> None:
        """Script the activity answer and, optionally, the handshake."""
        self.body = body
        self.status = status
        self.handshake = (
            _read("examples/capabilities/success.json") if handshake is None else handshake
        )
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Record and answer one request."""
        self.requests.append(request)
        if request.url.path == _CAPABILITIES_PATH:
            return httpx.Response(HTTPStatus.OK, json=self.handshake)
        return httpx.Response(self.status, json=self.body)

    def activity_calls(self) -> list[httpx.Request]:
        """Every request that reached Creek's activity route."""
        return [r for r in self.requests if r.url.path == _CREEK_ACTIVITY_PATH]


def _serve(creek: _Creek) -> None:
    """Make every request's vault an adapter over *creek*."""

    def _client() -> CreekVaultPipelineClient:
        return HttpCreekVaultClient(
            "https://vault.example.test",
            "activity-route-key",  # pragma: allowlist secret
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(creek)),
        )

    app.dependency_overrides[get_creek_vault_client] = _client


def _validate(response: Response) -> None:
    """Hold a live body to the schema the published document declares for it."""
    document = live_document()
    schema = declared_response_schema(document, "get", _ACTIVITY, response.status_code)
    response_validator(document, schema).validate(response.json())


async def _approved(
    async_client: AsyncClient, db_session: AsyncSession, account: str, agent: str | None
) -> tuple[dict[str, str], int, str]:
    """A fresh account with a self-connected vault and one approved agent."""
    headers, user_id = await signup(async_client, account)
    resource = await connect_vault(db_session, user_id, account)
    client_id = await register_agent(async_client, name=agent or "")
    await approve(async_client, headers, client_id, resource)
    return headers, user_id, client_id


# --- the shape -------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_published_success_cell_comes_back_in_plain_words(
    async_client: AsyncClient,
) -> None:
    """Creek's own example: two calls by a stamp nobody here owns, one by Adepthood.

    The issue's example, row for row: newest first, each row exactly four keys,
    the app's own ``adepthood`` stamp named as Adepthood, and the person reading
    "Drafted an essay" and "Tried to re-sort the vault" rather than tool names.
    """
    headers, _user_id = await signup(async_client, "activity_cell")
    _serve(_Creek(_read("examples/agent-activity/success.json")))

    response = await async_client.get(_ACTIVITY, headers=headers)

    assert response.status_code == HTTPStatus.OK
    _validate(response)
    body = response.json()
    assert set(body) == {"status", "rows"}
    assert body["status"] == "ok"
    assert [set(row) for row in body["rows"]] == [_ROW_KEYS] * 3
    assert body["rows"] == [
        {
            "agent": ACTIVITY_SOMETHING_ELSE,
            "tool_label": "Drafted an essay",
            "at": "2026-10-24T18:02:11Z",
            "outcome": "admitted",
        },
        {
            "agent": ACTIVITY_SOMETHING_ELSE,
            "tool_label": "Tried to re-sort the vault",
            "at": "2026-10-24T18:01:50Z",
            "outcome": "refused",
        },
        {
            "agent": ACTIVITY_ADEPTHOOD,
            "tool_label": "Saved a journal entry",
            "at": "2026-10-24T17:40:03Z",
            "outcome": "admitted",
        },
    ]


def test_the_three_named_tools_read_as_the_issue_names_them() -> None:
    """``creek.draft``, ``creek.reflect`` and ``creek.link`` in the words #3535 fixed."""
    assert TOOL_LABELS["creek.draft"] == "Drafted an essay"
    assert TOOL_LABELS["creek.reflect"] == "Asked for a reflection"
    assert TOOL_LABELS["creek.link"] == "Tried to re-sort the vault"


@pytest.mark.asyncio
async def test_an_empty_log_is_ok_with_no_rows(async_client: AsyncClient) -> None:
    """Nothing asked yet is an answer, which the screen renders as its empty state."""
    headers, _user_id = await signup(async_client, "activity_empty")
    _serve(_Creek(_read("examples/agent-activity/empty.json")))

    response = await async_client.get(_ACTIVITY, headers=headers)

    assert response.json() == {"status": "ok", "rows": []}


@pytest.mark.asyncio
async def test_the_limit_defaults_to_fifty_and_is_forwarded(async_client: AsyncClient) -> None:
    """``?limit=`` reaches Creek as its only parameter; absent, it is fifty."""
    headers, _user_id = await signup(async_client, "activity_limit")
    creek = _Creek(_answer([]))
    _serve(creek)

    await async_client.get(_ACTIVITY, headers=headers)
    await async_client.get(_ACTIVITY, params={"limit": _SETTINGS_LIMIT}, headers=headers)

    first, second = creek.activity_calls()
    assert dict(first.url.params) == {"limit": str(_DEFAULT_LIMIT)}
    assert dict(second.url.params) == {"limit": str(_SETTINGS_LIMIT)}


@pytest.mark.asyncio
@pytest.mark.parametrize("limit", ["0", "201", "-3", "many"])
async def test_a_limit_outside_one_to_two_hundred_is_refused(
    async_client: AsyncClient, limit: str
) -> None:
    """The published bounds, refused here rather than relayed for Creek to refuse."""
    headers, _user_id = await signup(async_client, f"activity_bad_limit_{limit.strip('-')}")
    creek = _Creek(_answer([]))
    _serve(creek)

    response = await async_client.get(_ACTIVITY, params={"limit": limit}, headers=headers)

    assert response.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
    assert creek.activity_calls() == []


@pytest.mark.asyncio
async def test_more_rows_than_asked_for_are_cut_to_the_limit(async_client: AsyncClient) -> None:
    """A vault that over-answers does not make the list longer than the screen asked."""
    headers, _user_id = await signup(async_client, "activity_overlong")
    rows = [_row("adepthood", "creek.journal", f"2026-10-24T17:{m:02d}:00Z") for m in range(5)]
    _serve(_Creek(_answer(rows)))

    response = await async_client.get(_ACTIVITY, params={"limit": _OVERLONG_LIMIT}, headers=headers)

    assert len(response.json()["rows"]) == _OVERLONG_LIMIT


@pytest.mark.asyncio
async def test_activity_needs_a_signed_in_account(async_client: AsyncClient) -> None:
    """No bearer, no activity."""
    response = await async_client.get(_ACTIVITY)

    assert response.status_code == HTTPStatus.UNAUTHORIZED


# --- attribution -----------------------------------------------------------


@pytest.mark.asyncio
async def test_a_stamp_that_is_one_of_this_accounts_agents_is_named_after_it(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """The Creek-Vault#1976 shape: a call stamped with an approved agent's own client id."""
    headers, _user_id, client_id = await _approved(
        async_client, db_session, "activity_named", "OpenClaw on my Mac mini"
    )
    _serve(_Creek(_answer([_row(client_id, "creek.draft", "2026-10-24T18:02:11Z")])))

    (row,) = (await async_client.get(_ACTIVITY, headers=headers)).json()["rows"]

    assert row["agent"] == "OpenClaw on my Mac mini"


@pytest.mark.asyncio
async def test_an_agent_that_gave_no_name_is_named_as_the_consent_page_names_it(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """One sentence for a nameless agent, on the consent page and here."""
    headers, _user_id, client_id = await _approved(
        async_client, db_session, "activity_unnamed", None
    )
    _serve(_Creek(_answer([_row(client_id, "creek.reflect", "2026-10-24T18:02:11Z")])))

    (row,) = (await async_client.get(_ACTIVITY, headers=headers)).json()["rows"]

    assert row["agent"] == CONSENT_UNNAMED_AGENT
    assert row["tool_label"] == "Asked for a reflection"


@pytest.mark.asyncio
async def test_an_agent_since_stopped_is_said_to_be_stopped(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A revoked grant leaves the agent list, but its past calls still say whose they were."""
    headers, _user_id, client_id = await _approved(
        async_client, db_session, "activity_stopped", "Claude Code"
    )
    (listed,) = (await async_client.get("/vault/agents", headers=headers)).json()
    await async_client.delete(f"/vault/agents/{listed['id']}", headers=headers)
    _serve(_Creek(_answer([_row(client_id, "creek.mine", "2026-10-24T18:02:11Z")])))

    (row,) = (await async_client.get(_ACTIVITY, headers=headers)).json()["rows"]

    assert row["agent"] == ACTIVITY_STOPPED_AGENT


@pytest.mark.asyncio
async def test_another_accounts_agent_is_not_named_here(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """A client id joins only this account's own grants: a neighbour's is "something else"."""
    _neighbour, _neighbour_id, neighbours_client = await _approved(
        async_client, db_session, "activity_neighbour", "Neighbour's agent"
    )
    headers, _user_id = await signup(async_client, "activity_self")
    _serve(_Creek(_answer([_row(neighbours_client, "creek.draft", "2026-10-24T18:02:11Z")])))

    (row,) = (await async_client.get(_ACTIVITY, headers=headers)).json()["rows"]

    assert row["agent"] == ACTIVITY_SOMETHING_ELSE


@pytest.mark.asyncio
async def test_the_persons_own_subject_on_a_self_connected_vault_is_one_of_their_agents(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """Today's stamp: ``sub``, which names the person, so it cannot say *which* agent."""
    headers, user_id, _client_id = await _approved(
        async_client, db_session, "activity_subject", "OpenClaw"
    )
    subject = derived_subject(user_id, session_signing_secret())
    _serve(_Creek(_answer([_row(subject, "creek.draft", "2026-10-24T18:02:11Z")])))

    (row,) = (await async_client.get(_ACTIVITY, headers=headers)).json()["rows"]

    assert row["agent"] == ACTIVITY_ONE_OF_YOUR_AGENTS


async def _managed(db_session: AsyncSession, user_id: int, account: str) -> None:
    """Give ``user_id`` a ready managed vault provisioned under one consumer identity."""
    await store_vault_config(
        db_session,
        user_id,
        vault_url=vault_url_for(account),
        api_key=VAULT_KEY,
        provisioned=True,
    )
    db_session.add(
        VaultActivation(
            user_id=user_id,
            activation_id=f"activation-{account}",
            consumer_identity=_MANAGED_IDENTITY,
            state=VaultActivationState.READY.value,
        )
    )
    await db_session.commit()


@pytest.mark.asyncio
async def test_a_managed_vaults_one_stamp_is_adepthood_or_an_agent_once_one_is_approved(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """On a managed vault the app and every agent share one stamp; the row says so."""
    headers, user_id = await signup(async_client, "activity_managed")
    await _managed(db_session, user_id, "activity-managed")
    client_id = await register_agent(async_client, name="ChatGPT")
    await approve(async_client, headers, client_id, "https://v-activity-managed.vaults.example/mcp")
    _serve(_Creek(_answer([_row(_MANAGED_IDENTITY, "creek.draft", "2026-10-24T18:02:11Z")])))

    (row,) = (await async_client.get(_ACTIVITY, headers=headers)).json()["rows"]

    assert row["agent"] == ACTIVITY_ADEPTHOOD_OR_AN_AGENT


@pytest.mark.asyncio
async def test_a_managed_vaults_stamp_is_adepthood_while_no_agent_was_ever_approved(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    """With no grant ever written, nothing but the app holds a way into the vault."""
    headers, user_id = await signup(async_client, "activity_managed_alone")
    await _managed(db_session, user_id, "activity-managed-alone")
    _serve(_Creek(_answer([_row(_MANAGED_IDENTITY, "creek.journal", "2026-10-24T18:02:11Z")])))

    (row,) = (await async_client.get(_ACTIVITY, headers=headers)).json()["rows"]

    assert row["agent"] == ACTIVITY_ADEPTHOOD


# --- content-free, whatever Creek sends -------------------------------------


@pytest.mark.asyncio
async def test_extra_keys_and_prose_from_creek_never_cross_or_reach_a_log(
    async_client: AsyncClient, caplog: pytest.LogCaptureFixture
) -> None:
    """The issue's content-free invariant, end to end.

    A Creek answer carrying an argument summary, a fragment id and a path on
    its rows, and prose on its envelope, is refused whole: the route answers
    the same "unavailable" an absent vault gets, and neither the response nor
    any log record carries a byte of what was refused.
    """
    headers, _user_id = await signup(async_client, "activity_leak")
    leaky = _answer(
        [
            _row("adepthood", "creek.draft", "2026-10-24T18:02:11Z")
            | {
                "args_summary": {"topic": _PROSE},
                "fragment_id": "frag-3f9a1c7e40b2",
                "path": "07-Voice/Drafts/the-long-way-home.md",
            }
        ]
    ) | {"note": _PROSE}
    _serve(_Creek(leaky))

    with caplog.at_level(logging.DEBUG):
        response = await async_client.get(_ACTIVITY, headers=headers)

    assert response.status_code == HTTPStatus.OK
    assert response.json() == {"status": "unavailable", "rows": []}
    for needle in (_PROSE, "frag-3f9a1c7e40b2", "the-long-way-home", "args_summary"):
        assert needle not in response.text
        assert needle not in caplog.text


@pytest.mark.asyncio
async def test_a_consumer_carrying_prose_is_never_echoed(async_client: AsyncClient) -> None:
    """``consumer`` is any printable string to Creek; here it is only ever a key."""
    headers, _user_id = await signup(async_client, "activity_consumer_prose")
    _serve(_Creek(_answer([_row(_PROSE, "creek.draft", "2026-10-24T18:02:11Z")])))

    response = await async_client.get(_ACTIVITY, headers=headers)

    assert _PROSE not in response.text
    assert response.json()["rows"][0]["agent"] == ACTIVITY_SOMETHING_ELSE


@pytest.mark.asyncio
@pytest.mark.parametrize("tool", ["creek.state.render", "<unregistered>", "creek.someday"])
async def test_a_tool_without_plain_words_is_other(async_client: AsyncClient, tool: str) -> None:
    """A tool name never reaches a person; one with no sentence yet is "Other"."""
    headers, _user_id = await signup(async_client, f"activity_other_{len(tool)}")
    _serve(_Creek(_answer([_row("adepthood", tool, "2026-10-24T18:02:11Z")])))

    (row,) = (await async_client.get(_ACTIVITY, headers=headers)).json()["rows"]

    assert row["tool_label"] == ACTIVITY_OTHER_TOOL
    assert tool not in row.values()


# --- degrading -------------------------------------------------------------


def _without_activity() -> dict[str, object]:
    """The published handshake, with ``agent-activity`` withheld."""
    handshake = _read("examples/capabilities/success.json")
    names = handshake["capabilities"]
    assert isinstance(names, list)
    return handshake | {"capabilities": [n for n in names if n != "agent-activity"]}


_DEGRADES: Final[Mapping[str, Callable[[], _Creek]]] = {
    "capability withheld": lambda: _Creek(_answer([]), handshake=_without_activity()),
    "vault reports unavailable": lambda: _Creek(
        _read("examples/agent-activity/unavailable-service.json"),
        status=HTTPStatus.SERVICE_UNAVAILABLE,
    ),
    "version skew": lambda: _Creek(
        _read("examples/agent-activity/incompatible-version.json"), status=HTTPStatus.CONFLICT
    ),
    "credential refused": lambda: _Creek({}, status=HTTPStatus.UNAUTHORIZED),
    "unreadable answer": lambda: _Creek(["not", "an", "object"]),
}


@pytest.mark.asyncio
@pytest.mark.parametrize("case", list(_DEGRADES))
async def test_a_vault_that_cannot_answer_degrades_to_unavailable(
    async_client: AsyncClient, case: str
) -> None:
    """Every way a read can fail is the one "vault unavailable" answer, never an error."""
    headers, _user_id = await signup(async_client, f"activity_degrade_{len(case)}")
    _serve(_DEGRADES[case]())

    response = await async_client.get(_ACTIVITY, headers=headers)

    assert response.status_code == HTTPStatus.OK
    assert response.json() == {"status": "unavailable", "rows": []}
    _validate(response)


@pytest.mark.asyncio
async def test_an_account_with_no_vault_is_unavailable_without_a_dial(
    async_client: AsyncClient,
) -> None:
    """The local fallback has no audit chain to read, and says so as unavailable."""
    headers, _user_id = await signup(async_client, "activity_no_vault")
    app.dependency_overrides[get_creek_vault_client] = LocalFallbackCreekVaultClient

    response = await async_client.get(_ACTIVITY, headers=headers)

    assert response.json() == {"status": "unavailable", "rows": []}
