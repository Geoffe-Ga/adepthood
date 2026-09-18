"""A stop the writer asks for is not reordered behind the sending it stops.

``PUT /corpus/consent/{source}`` serves both decisions. On a grant it runs the
backfill sweep, which is bounded only by
:data:`services.corpus_backfill.BACKFILL_ENTRY_CEILING` provider calls and
:data:`services.corpus_backfill.BACKFILL_DEADLINE_SECONDS`. On a revocation it
carries the word *stop*. The account barrier is exclusive, so a hold taken
across the whole sweep does not merely delay the revocation -- it reorders it to
after every dial the sweep has left.

That is a regression against the behaviour without the barrier at all, and it is
the only place in this lane where the ordering made something worse rather than
better. :func:`services.corpus_ingest.ingest_journal_entry` re-reads consent per
entry and :func:`services.corpus_backfill._offer_batch` commits per iteration, so
before the barrier a revocation committed by a concurrent request was observed
by the sweep in flight and the remaining bodies stayed home. The property this
module pins is that one: **a revocation is effective mid-sweep, so the writing
the sweep had not reached when the writer said stop is never sent.**

Written at the HTTP seam, because the defect is an ordering between two requests
and no unit test of either one can see it.
"""

from __future__ import annotations

import asyncio
import json
from http import HTTPStatus
from typing import TYPE_CHECKING, Final

import pytest

from domain.frequencies import Frequency
from models.corpus_fragment import CorpusSource
from services import frequency_classification as fc
from services.botmason import STUB_MODEL_NAME, LLMResponse
from tests.test_account_egress_barrier import signup

if TYPE_CHECKING:
    from httpx import AsyncClient, Response

#: The writing the sweep is asked to ontologize, newest last. The sweep takes
#: the newest first, so the body the in-flight dial carries is the last of these
#: and the two that must stay home are the two before it.
_BODIES: Final[tuple[str, ...]] = (
    "I sat with the thing I have been avoiding.",
    "This morning it was easier than yesterday.",
    "By the river the willow bent without breaking.",
)

#: A reply the classifier's parser accepts, naming one position on the ontology.
_CLASSIFIED_REPLY: Final = json.dumps(
    {"weights": {Frequency.F5.value: 0.9}, "overall_confidence": 0.9}
)

_CONSENT_PATH: Final = f"/corpus/consent/{CorpusSource.JOURNAL.value}"

#: Markers on the shared order list, named once so the double and the assertions
#: cannot drift apart on a typo.
STOP_ASKED: Final = "revocation-issued"
DIAL_SENT: Final = "classification-sent"

_SETTLE_TIMEOUT_SECONDS: Final = 20.0

#: How long the revocation is given to commit while a dial is held open. Under
#: a hold taken across the whole sweep it cannot, which is the defect; under a
#: hold taken per dial it waits only for the dial in flight, which is the
#: narrowest wait an ordering can impose.
_OVERTAKE_PROBE_SECONDS: Final = 1.0


class PausedClassifier:
    """A ``generate_response`` stand-in that holds the *first* classification open.

    Instance-local, like every other double in this lane: no module state, so the
    result cannot depend on the order pytest runs the file in.

    ``bodies`` records what was actually transmitted, because "a dial happened"
    and "this account's stored writing left the process" are different claims and
    only the second one is the defect.
    """

    def __init__(self) -> None:
        """Answer every dial with one classified reply and record nothing yet."""
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.order: list[str] = []
        self.bodies: list[str] = []

    async def __call__(
        self,
        *,
        user_message: str,
        conversation_history: object,
        system_prompt: str | None = None,
        api_key: object = None,
    ) -> LLMResponse:
        """Hold the first dial open, then record what each one transmitted."""
        del conversation_history, system_prompt, api_key
        if not self.started.is_set():
            self.started.set()
            await self.release.wait()
        self.order.append(DIAL_SENT)
        self.bodies.append(user_message)
        return LLMResponse(
            text=_CLASSIFIED_REPLY,
            provider="stub",
            model=STUB_MODEL_NAME,
            prompt_tokens=0,
            completion_tokens=0,
        )


async def _write(client: AsyncClient, headers: dict[str, str], body: str) -> None:
    """Store one journal entry, before any consent exists to classify it under."""
    written = await client.post(
        "/journal/", json={"message": body, "classification": "personal"}, headers=headers
    )
    assert written.status_code == HTTPStatus.CREATED, written.text


async def _decide(client: AsyncClient, headers: dict[str, str], *, granted: bool) -> Response:
    """Record one decision about the journal source."""
    return await client.put(_CONSENT_PATH, json={"granted": granted}, headers=headers)


@pytest.mark.asyncio
async def test_a_revocation_is_effective_while_the_grant_is_still_sweeping(
    concurrent_async_client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The writing the sweep had not reached when the writer said stop stays home.

    The revocation is issued while the sweep's first classification is held open,
    and it is given a window to commit before the dial is released. Held across
    the whole sweep, the barrier makes the remaining two bodies go out anyway and
    then answers the revocation 200, describing a state the writer asked for
    before those dials happened.
    """
    classifier = PausedClassifier()
    monkeypatch.setattr(fc, "generate_response", classifier)
    headers, _email = await signup(concurrent_async_client, "revoke_mid_sweep")
    for body in _BODIES:
        await _write(concurrent_async_client, headers, body)

    granting = asyncio.create_task(_decide(concurrent_async_client, headers, granted=True))
    await asyncio.wait_for(classifier.started.wait(), timeout=_SETTLE_TIMEOUT_SECONDS)
    classifier.order.append(STOP_ASKED)
    revoking = asyncio.create_task(_decide(concurrent_async_client, headers, granted=False))
    await asyncio.wait({revoking}, timeout=_OVERTAKE_PROBE_SECONDS)
    classifier.release.set()
    granted, revoked = await asyncio.wait_for(
        asyncio.gather(granting, revoking), timeout=_SETTLE_TIMEOUT_SECONDS
    )

    assert granted.status_code == HTTPStatus.OK, granted.text
    assert revoked.status_code == HTTPStatus.OK, revoked.text
    assert revoked.json()["granted"] is False
    assert classifier.bodies == [_BODIES[-1]], (
        f"the writer revoked mid-sweep and their remaining journal bodies were sent to "
        f"the provider anyway: {classifier.bodies}"
    )
    assert classifier.order == [STOP_ASKED, DIAL_SENT], (
        f"exactly one dial may follow the stop -- the one already in flight when it "
        f"was asked for: {classifier.order}"
    )
