"""Creek contracts 0.35 and 0.36 on reflections and letters, without moving the 0.22 pin (#3778).

0.35 (Creek-Vault#2126) writes a letter or a reflection in the owner's own
voice for a caller declaring 0.35 or later, and says which voice it used in
``voice``. 0.36 (Creek-Vault#2127) names the threads an entry belongs to on a
reflection (``related_threads``), and the praxis, eddies and threads it touches
on a letter. Every one of those keys is omitted when nothing qualifies and for a
caller declaring an earlier minor.

So the two keyed generation calls declare 0.36 to a vault whose handshake lists
it, 0.28 to one that lists only that, and the pin otherwise -- an older vault
keeps hearing a minor it serves and keeps writing in the Higher Self's voice.
Everything else keeps its own minor.

These tests drive the real adapter against a ``MockTransport`` vault and pin
the snapshot, the vocabularies and caps against the published schemas, the
negotiation, and the projection of every new field, including the omitted
and the off-schema cases. Expectations are literals, for the reason
``tests/test_creek_contract_0_21.py`` gives.
"""

from __future__ import annotations

import copy
import hashlib
import json
from collections.abc import Callable
from http import HTTPStatus
from pathlib import Path
from typing import Any, Final

import httpx
import jsonschema
import pytest

from domain.creek_vault import (
    CONTRACT_VERSION,
    VaultLetter,
    VaultLetterRequest,
    VaultReflection,
    VaultTierCeiling,
)
from domain.vault_related import (
    RELATED_SURFACES_SINCE_MINOR,
    VaultRelatedThread,
    VaultReplyVoice,
    VaultThreadStatus,
)
from services.creek_vault_client import HttpCreekVaultClient
from services.creek_vault_payload import (
    _MAX_RELATED_EDDIES,
    _MAX_RELATED_PRAXIS,
    _MAX_RELATED_THREADS,
)

#: The reviewed Creek-Vault commit the snapshot was copied from (a git SHA, not a secret).
_PINNED_COMMIT: Final = "c59d65db379838ee859cfaccb19684cc962c858b"  # pragma: allowlist secret
_ROOT: Final = Path(__file__).parent / "fixtures" / "creek_related_voice_v036"
_VAULT_URL: Final = "https://vault.example.test"
_API_KEY: Final = "contract-036-test-key"  # pragma: allowlist secret
_CONTRACT_HEADER: Final = "X-Creek-Contract-Version"
_REFLECTIONS: Final = "/v1/reflections"
_LETTERS_PREFIX: Final = "/v1/letters/"

#: The minor both calls declare to a vault listing it. A literal.
_RELATED_MINOR: Final = "0.36"
_KEY_REJECTED_MINOR: Final = "0.28"
_PINNED_MINOR: Final = "0.22"

_BODY: Final = "I keep saying yes to things I do not want, and then I rest too late."


def _json(path: Path) -> dict[str, Any]:
    """Load one vendored JSON document."""
    loaded: dict[str, Any] = json.loads(path.read_bytes())
    return loaded


def _capabilities(minors: list[str] | None = None) -> dict[str, Any]:
    """The 0.36 capability document, optionally narrowed to ``minors``."""
    document = copy.deepcopy(_json(_ROOT / "examples" / "capabilities" / "success.json"))
    if minors is not None:
        document["supported_contract_minors"] = minors
    return document


def _letter_cell() -> dict[str, Any]:
    """The published 0.36 letter: owner voice, one of each related page."""
    return _json(_ROOT / "examples" / "letters" / "success.json")


def _reflection_cell() -> dict[str, Any]:
    """The published 0.36 reflection: owner voice and one related thread."""
    return _json(_ROOT / "examples" / "reflections" / "success.json")


def _schema(name: str) -> dict[str, Any]:
    """One vendored schema."""
    return _json(_ROOT / "schemas" / f"{name}.schema.json")


class _Vault:
    """A vault answering its handshake and one generation route, recording each request."""

    def __init__(
        self, capabilities: dict[str, Any], answer: Callable[[httpx.Request], httpx.Response]
    ) -> None:
        """Serve ``capabilities``, and ``answer`` for anything else."""
        self.capabilities = capabilities
        self.answer = answer
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        """Record the request, then answer it."""
        self.requests.append(request)
        if request.url.path == "/v1/capabilities":
            return httpx.Response(HTTPStatus.OK, json=self.capabilities)
        return self.answer(request)

    def declared(self, prefix: str) -> list[str | None]:
        """The minor every request under ``prefix`` declared."""
        return [
            request.headers.get(_CONTRACT_HEADER)
            for request in self.requests
            if request.url.path.startswith(prefix)
        ]


def _answering(body: object) -> Callable[[httpx.Request], httpx.Response]:
    """A route that always answers ``body`` with 200."""

    def _answer(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(HTTPStatus.OK, json=body)

    return _answer


def _letter_request() -> VaultLetterRequest:
    """The request the published letter cell answers: its id, at the personal tier."""
    return VaultLetterRequest(
        external_id=_letter_cell()["external_id"],
        content=_BODY,
        note="You keep agreeing before you check.",
        anchor_text="I keep saying yes",
        kind="theme",
        tier=VaultTierCeiling.PERSONAL,
    )


async def _reflect(vault: _Vault) -> VaultReflection:
    """Handshake, then reflect through the real adapter."""
    async with httpx.AsyncClient(transport=httpx.MockTransport(vault)) as http:
        client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http, managed=True)
        await client.handshake()
        return await client.reflect(_BODY, VaultTierCeiling.PERSONAL)


async def _write_letter(vault: _Vault) -> VaultLetter:
    """Handshake, then ask for the letter through the real adapter."""
    async with httpx.AsyncClient(transport=httpx.MockTransport(vault)) as http:
        client = HttpCreekVaultClient(_VAULT_URL, _API_KEY, http_client=http, managed=True)
        await client.handshake()
        return await client.write_letter(_letter_request())


def test_the_snapshot_is_pinned_to_the_producer_manifest_and_the_pin_stays_0_22() -> None:
    """Every copied byte matches Creek's manifest; the base pin does not move."""
    vendor = _json(_ROOT / "vendor.json")
    manifest = _json(_ROOT / "manifest.json")
    assert vendor["commit"] == _PINNED_COMMIT
    assert vendor["contract_version"] == manifest["contract_version"] == "0.36.0"
    assert CONTRACT_VERSION == "0.22.0"
    assert RELATED_SURFACES_SINCE_MINOR == _RELATED_MINOR
    upstream = {entry["path"]: entry["sha256"] for entry in manifest["files"]}
    assert set(vendor["files"]) == {
        path.relative_to(_ROOT).as_posix()
        for path in _ROOT.rglob("*.json")
        if path.name != "vendor.json"
    }
    for name, digest in vendor["files"].items():
        assert hashlib.sha256((_ROOT / name).read_bytes()).hexdigest() == digest
        if name != "manifest.json":
            assert upstream[name] == digest


def test_the_published_cells_validate_against_their_schemas() -> None:
    """The two cells this suite serves are ones Creek publishes."""
    jsonschema.validate(_letter_cell(), _schema("LetterResponse"))
    jsonschema.validate(_reflection_cell(), _schema("ReflectionResponse"))


def test_the_vocabularies_and_caps_are_creeks_published_ones() -> None:
    """Voice and thread status off the schemas; every cap equals its ``maxItems``."""
    thread = _schema("RelatedThread")
    letter = _schema("LetterResponse")
    reflection = _schema("ReflectionResponse")
    assert {voice.value for voice in VaultReplyVoice} == set(letter["$defs"]["ReplyVoice"]["enum"])
    assert {status.value for status in VaultThreadStatus} == set(
        thread["$defs"]["ThreadLifecycle"]["enum"]
    )
    assert set(thread["required"]) == {"id", "title", "status"}

    def _cap(document: dict[str, Any], key: str) -> int:
        cap: int = document["properties"][key]["anyOf"][0]["maxItems"]
        return cap

    assert _cap(reflection, "related_threads") == _MAX_RELATED_THREADS
    assert _cap(letter, "related_threads") == _MAX_RELATED_THREADS
    assert _cap(letter, "related_praxis") == _MAX_RELATED_PRAXIS
    assert _cap(letter, "related_eddies") == _MAX_RELATED_EDDIES


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("minors", "expected"),
    [
        (None, _RELATED_MINOR),
        ([_KEY_REJECTED_MINOR, "0.27", _PINNED_MINOR], _KEY_REJECTED_MINOR),
        ([_PINNED_MINOR, "0.21"], _PINNED_MINOR),
    ],
    ids=["lists_0_36", "lists_0_28_only", "lists_neither"],
)
async def test_both_generation_calls_declare_the_highest_minor_the_vault_lists(
    minors: list[str] | None, expected: str
) -> None:
    """0.36 to a 0.36 vault, 0.28 to a 0.28 one, the pin otherwise; the handshake is bare."""
    reflections = _Vault(_capabilities(minors), _answering(_reflection_cell()))
    await _reflect(reflections)
    letters = _Vault(_capabilities(minors), _answering(_letter_cell()))
    await _write_letter(letters)
    assert reflections.declared(_REFLECTIONS) == [expected]
    assert letters.declared(_LETTERS_PREFIX) == [expected]
    assert reflections.requests[0].headers.get(_CONTRACT_HEADER) is None


@pytest.mark.asyncio
async def test_a_reflection_carries_the_threads_creek_names() -> None:
    """The published thread survives as the seam's value, beside praxis and eddies."""
    reflection = await _reflect(_Vault(_capabilities(), _answering(_reflection_cell())))
    assert reflection.related_threads == (
        VaultRelatedThread(
            id="thread-0000000001", title="Leaving the firm", status=VaultThreadStatus.ACTIVE
        ),
    )
    assert [page.title for page in reflection.related_praxis] == ["Rest before the collapse"]
    assert [eddy.title for eddy in reflection.related_eddies] == ["Rest and Ruin"]


@pytest.mark.asyncio
async def test_a_letter_carries_its_voice_and_every_related_page() -> None:
    """Owner voice, and the praxis, eddy and thread the published letter names."""
    letter = await _write_letter(_Vault(_capabilities(), _answering(_letter_cell())))
    assert letter.voice is VaultReplyVoice.OWNER
    assert [page.title for page in letter.related_praxis] == ["Rest before the collapse"]
    assert [eddy.title for eddy in letter.related_eddies] == ["Rest and Ruin"]
    assert [thread.title for thread in letter.related_threads] == ["Leaving the firm"]


@pytest.mark.asyncio
async def test_an_omitted_or_null_field_is_an_ordinary_answer_carrying_nothing() -> None:
    """Creek omits each key when nothing qualifies, and older vaults never send them."""
    letter_body = _letter_cell()
    for key in ("voice", "related_praxis", "related_eddies"):
        del letter_body[key]
    letter_body["related_threads"] = None
    letter = await _write_letter(_Vault(_capabilities(), _answering(letter_body)))
    assert letter.voice is None
    assert (letter.related_praxis, letter.related_eddies, letter.related_threads) == ((), (), ())
    reflection_body = _reflection_cell()
    del reflection_body["related_threads"]
    reflection = await _reflect(_Vault(_capabilities(), _answering(reflection_body)))
    assert reflection.related_threads == ()


@pytest.mark.asyncio
async def test_off_schema_pages_are_dropped_one_at_a_time_and_bounded_at_the_cap() -> None:
    """A thread missing a field or outside the lifecycle is dropped; extras past two unread."""
    good = {"id": "thread-2", "title": "Coming home", "status": "dormant"}
    body = _letter_cell()
    body["voice"] = "a third voice"
    body["related_threads"] = [
        {"id": "thread-1", "title": "No status"},
        {"id": "thread-x", "title": "Unknown", "status": "paused"},
        good,
        good,
    ]
    letter = await _write_letter(_Vault(_capabilities(), _answering(body)))
    assert letter.voice is None
    # Only the first two items are read at all; both are off-schema.
    assert letter.related_threads == ()
    body["related_threads"] = [good, {"id": "", "title": "Blank id", "status": "active"}]
    letter = await _write_letter(_Vault(_capabilities(), _answering(body)))
    assert letter.related_threads == (
        VaultRelatedThread(id="thread-2", title="Coming home", status=VaultThreadStatus.DORMANT),
    )


@pytest.mark.asyncio
async def test_a_higher_self_letter_says_so() -> None:
    """``higher_self`` is read as such, so nothing claims the owner's voice."""
    body = _letter_cell()
    body["voice"] = "higher_self"
    letter = await _write_letter(_Vault(_capabilities(), _answering(body)))
    assert letter.voice is VaultReplyVoice.HIGHER_SELF
