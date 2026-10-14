"""The client-direct page read asks the vendor exactly what the server would have.

ADR 0009 phase (a) (#3067) moved page reading to the device: a writer's own
key goes from their device straight to its vendor, never through this server.
The prompt, the model, the token budget and the reply classifier therefore have
a TypeScript twin in ``frontend/src/api/transcriptionContract.ts``. A twin is
honest only while something fails when it drifts, so both sides are held to one
shared fixture, ``tests/fixtures/transcription_contract/transcription_contract.json``:
this file derives every field of it from the Python, and
``frontend/src/api/__tests__/transcriptionContract.test.ts`` holds the
TypeScript to the same file.
"""

from __future__ import annotations

import json
import re
from http import HTTPStatus
from pathlib import Path
from typing import TYPE_CHECKING, Any, Final

import pytest

from domain.care import MEDICATION_GUARDRAIL
from domain.transcription import (
    MAX_REFUSAL_CHARS,
    REFUSAL_OBJECT_CUES,
    REFUSAL_OPENERS,
    TranscriptionVerdict,
    build_transcription_prompt,
    classify_transcription,
)
from services import botmason
from tests.provider_transport import (
    ANTHROPIC_KEY,
    OPENAI_KEY,
    TransportStub,
    use_anthropic,
    use_openai,
)

if TYPE_CHECKING:
    from collections.abc import Callable

_FIXTURE: Final = (
    Path(__file__).parent / "fixtures" / "transcription_contract" / "transcription_contract.json"
)
_PAGE: Final = botmason.ImagePayload(media_type="image/png", data="aGVsbG8=")
_OPENAI_OK: Final[dict[str, object]] = {
    "id": "chatcmpl-1",
    "object": "chat.completion",
    "created": 0,
    "model": "gpt-4o-mini",
    "choices": [{"index": 0, "message": {"role": "assistant", "content": "page"}}],
    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
}
_ANTHROPIC_OK: Final[dict[str, object]] = {
    "id": "msg_1",
    "type": "message",
    "role": "assistant",
    "model": "claude-sonnet-5",
    "content": [{"type": "text", "text": "page"}],
    "stop_reason": "end_turn",
    "stop_sequence": None,
    "usage": {"input_tokens": 1, "output_tokens": 1},
}


def _contract() -> dict[str, Any]:
    """The shared fixture, parsed."""
    loaded: dict[str, Any] = json.loads(_FIXTURE.read_text(encoding="utf-8"))
    return loaded


def _cases() -> list[dict[str, str]]:
    """The classifier cases the fixture pins, each a reply and its verdict."""
    cases: list[dict[str, str]] = _contract()["classify_cases"]
    return cases


def _arm_openai(monkeypatch: pytest.MonkeyPatch) -> tuple[TransportStub, str]:
    return use_openai(monkeypatch, HTTPStatus.OK, _OPENAI_OK), OPENAI_KEY


def _arm_anthropic(monkeypatch: pytest.MonkeyPatch) -> tuple[TransportStub, str]:
    return use_anthropic(monkeypatch, HTTPStatus.OK, _ANTHROPIC_OK), ANTHROPIC_KEY


def _system_prompt_sent(provider: str, body: dict[str, Any]) -> str:
    """The system text the SDK put on the wire, wherever its vendor expects it."""
    if provider == botmason.ANTHROPIC_PROVIDER_NAME:
        return str(body["system"])
    return str(body["messages"][0]["content"])


_ARMS: Final[dict[str, Callable[[pytest.MonkeyPatch], tuple[TransportStub, str]]]] = {
    botmason.OPENAI_PROVIDER_NAME: _arm_openai,
    botmason.ANTHROPIC_PROVIDER_NAME: _arm_anthropic,
}


def test_the_system_prompt_is_the_transcription_prompt_plus_the_guardrail() -> None:
    """The prompt, then the guardrail's defense-in-depth second copy."""
    assert _contract()["system_prompt"] == (
        f"{build_transcription_prompt()}\n\n{MEDICATION_GUARDRAIL}"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", sorted(_ARMS))
async def test_the_device_asks_each_vendor_what_the_server_sent(
    monkeypatch: pytest.MonkeyPatch, provider: str
) -> None:
    """Model, token budget and system prompt match the server's own default page read.

    The server's request is captured at the SDK transport, so this compares the
    fixture with what actually went on the wire rather than with a restatement.
    ``LLM_MODEL`` is unset, so the server reads with its registry default -- the
    model the device always uses (see the next test).
    The server's system text also carries a per-request delimiter instruction
    for its nonce-wrapped user text; the device sends no user text to wrap, so
    only the shared prefix is compared.
    """
    stub, key = _ARMS[provider](monkeypatch)
    monkeypatch.delenv("LLM_MODEL", raising=False)
    contract = _contract()

    await botmason.generate_response(
        "", [], system_prompt=build_transcription_prompt(), api_key=key, images=[_PAGE]
    )

    [body] = stub.bodies
    assert body["model"] == contract["registry_default_models"][provider]
    assert body["max_tokens"] == contract["max_tokens"]
    assert _system_prompt_sent(provider, body).startswith(f"{contract['system_prompt']}\n\n")


@pytest.mark.parametrize("provider", sorted(botmason.PROVIDER_REGISTRY))
def test_each_vendor_model_is_the_registry_default_and_sees_images(
    monkeypatch: pytest.MonkeyPatch, provider: str
) -> None:
    """The device always uses each vendor's audited default, whatever ``LLM_MODEL`` says.

    ``LLM_MODEL`` configures the server's own dial; a device-direct page read
    never reaches the server, so an operator's non-default model does not govern
    it. Set here to another allowlisted model to show the fixture is untouched.
    """
    spec = botmason.PROVIDER_REGISTRY[provider]
    monkeypatch.setenv("LLM_MODEL", min(spec.allowed_models - {spec.default_model}))
    model = _contract()["registry_default_models"][provider]

    assert model == spec.default_model
    assert botmason.supports_vision(provider, model) is True


def test_the_fixture_names_exactly_the_registered_vendors() -> None:
    """A vendor added on one side only is a drift this file has to see."""
    assert set(_contract()["registry_default_models"]) == set(botmason.PROVIDER_REGISTRY)


@pytest.mark.parametrize("case", _cases(), ids=lambda case: case["verdict"])
def test_each_pinned_reply_classifies_as_the_server_would(case: dict[str, str]) -> None:
    """The device's classifier is held to these verdicts; here they are held to the Python."""
    assert classify_transcription(case["reply"]).value == case["verdict"]


def test_the_cases_reach_every_verdict() -> None:
    """A fixture that never exercises one verdict cannot hold the mirror to it."""
    verdicts = {case["verdict"] for case in _cases()}
    assert verdicts == {verdict.value for verdict in TranscriptionVerdict}


#: Where a reply's first sentence ends, as the classifier reads it.
_SENTENCE_END: Final = re.compile(r"[.!?\n]")


def _refused_first_sentences() -> list[tuple[str, str]]:
    """Each refused case as (normalised reply, casefolded first sentence)."""
    refused = []
    for case in _cases():
        if case["verdict"] != TranscriptionVerdict.REFUSED.value:
            continue
        reply = case["reply"].replace("\u2019", "'").replace("\u2018", "'").strip()
        refused.append((reply, _SENTENCE_END.split(reply, maxsplit=1)[0].casefold()))
    return refused


@pytest.mark.parametrize("opener", REFUSAL_OPENERS)
@pytest.mark.parametrize("cue", REFUSAL_OBJECT_CUES)
def test_every_opener_and_cue_pair_has_a_refused_case(opener: str, cue: str) -> None:
    """A word dropped from either list on one side only must fail the other's mirror.

    The mirror is held to the fixture's verdicts, so a cue or opener no refused
    case exercises could vanish from the TypeScript lists unnoticed.
    """
    assert any(
        reply.startswith(opener) and cue in first for reply, first in _refused_first_sentences()
    ), f"no refused case opens with {opener!r} and names {cue!r} in its first sentence"


def test_the_refusal_length_bound_is_pinned_in_code_points() -> None:
    """Astral characters straddle the bound: counted as code points, not UTF-16 units."""
    astral = [case for case in _cases() if any(ord(ch) > 0xFFFF for ch in case["reply"])]
    lengths = {len(case["reply"].strip()): case["verdict"] for case in astral}

    assert lengths.get(MAX_REFUSAL_CHARS) == TranscriptionVerdict.REFUSED.value
    assert lengths.get(MAX_REFUSAL_CHARS + 1) == TranscriptionVerdict.TRANSCRIBED.value
