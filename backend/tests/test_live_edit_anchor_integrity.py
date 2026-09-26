"""Anchor integrity across live-editor edits to Unicode, Markdown-bearing bodies (#2891).

The live editor's value is always the exact stored source, so an edit that
inserts text before an anchor -- a new bullet, a formatting delimiter, an emoji,
a decomposed accent the server composes -- reaches ``PATCH /journal/{id}`` as a
plain body change. These pin, over bodies carrying the characters the editor
produces, that every pending promoted quote and active margin note either stays
on exactly its own text at the new code-point offset or is honestly marked
stale, and that a promote over the stored body snapshots exactly its own slice.
"""

from __future__ import annotations

from dataclasses import dataclass
from http import HTTPStatus
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from models.marginalia import Marginalia, MarginaliaKind, MarginaliaStatus


@dataclass(frozen=True)
class EditCase:
    """One live-editor case: a name, the typed body, and the anchored text."""

    name: str
    typed: str
    anchor: str


_EMOJI = "\N{GRINNING FACE}"
_WAVE = "\N{WATER WAVE}"
_ACUTE = "\N{COMBINING ACUTE ACCENT}"

_SURVIVING_EDITS = (
    EditCase("emoji before", f"Morning {_EMOJI} by the river.", "the river"),
    EditCase("combining mark", f"Cafe{_ACUTE} by the river.", "the river"),
    EditCase("escaped marker", r"a \*literal\* star by the river", r"\*literal\*"),
    EditCase("nested bullet", "- top\n  - by the river\n  - back", "by the river"),
    EditCase("bold", "so **bold** here by the river", "**bold**"),
    EditCase("underline", "<u>under</u> and the river", "<u>under</u>"),
)

# Each surviving case's edit inserts formatting, a bullet or Unicode BEFORE the anchor.
_INSERTIONS = {
    "emoji before": (f"{_WAVE} ", 0),
    "combining mark": (f"Ole{_ACUTE}! ", 0),
    "escaped marker": ("**new** ", 0),
    "nested bullet": ("  - fresh\n", len("- top\n")),
    "bold": ("_x_ ", 0),
    "underline": ("**b** ", 0),
}


def _edited(case: EditCase, stored: str) -> str:
    """Apply the case's insertion to the stored body, as the editor would."""
    text, at = _INSERTIONS[case.name]
    return stored[:at] + text + stored[at:]


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "secret12345",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    payload = resp.json()
    return {"Authorization": f"Bearer {payload['token']}"}, int(payload["user_id"])


async def _create(client: AsyncClient, headers: dict[str, str], typed: str) -> tuple[int, str]:
    """Create an entry the way the editor does; return its id and STORED body."""
    resp = await client.post("/journal/", json={"message": typed}, headers=headers)
    assert resp.status_code == HTTPStatus.CREATED
    data: dict[str, Any] = resp.json()
    return int(data["id"]), str(data["message"])


async def _promote(
    client: AsyncClient, headers: dict[str, str], entry_id: int, start: int, end: int
) -> dict[str, Any]:
    resp = await client.post(
        f"/journal/{entry_id}/promote",
        json={"anchor_start": start, "anchor_end": end},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED
    body: dict[str, Any] = resp.json()
    return body


async def _seed_note(
    session: AsyncSession, user_id: int, entry_id: int, stored: str, anchor: str
) -> None:
    start = stored.index(anchor)
    session.add(
        Marginalia(
            journal_entry_id=entry_id,
            user_id=user_id,
            kind=MarginaliaKind.SYMBOL,
            anchor_start=start,
            anchor_end=start + len(anchor),
            anchor_text=anchor,
            note="A note.",
        )
    )
    await session.commit()


async def _anchors_after_patch(
    client: AsyncClient, headers: dict[str, str], entry_id: int, new_body: str
) -> tuple[str, dict[str, Any], dict[str, Any]]:
    """PATCH the body; return the stored body, the quote and the note after it."""
    resp = await client.patch(f"/journal/{entry_id}", json={"message": new_body}, headers=headers)
    assert resp.status_code == HTTPStatus.OK
    stored = str(resp.json()["message"])
    quotes = (await client.get(f"/journal/{entry_id}/promotions", headers=headers)).json()
    notes = (await client.get(f"/journal/{entry_id}/marginalia", headers=headers)).json()
    assert len(quotes) == 1
    assert len(notes["items"]) == 1
    return stored, quotes[0], notes["items"][0]


@pytest.mark.asyncio
@pytest.mark.parametrize("case", _SURVIVING_EDITS, ids=lambda c: c.name)
async def test_insert_before_anchor_keeps_quote_and_note_on_their_own_text(
    async_client: AsyncClient, db_session: AsyncSession, case: EditCase
) -> None:
    """An insertion before the anchor re-anchors both to exactly their own text."""
    headers, user_id = await _signup(async_client, "keep-" + case.name.replace(" ", "-"))
    entry_id, stored = await _create(async_client, headers, case.typed)
    start = stored.index(case.anchor)
    quote = await _promote(async_client, headers, entry_id, start, start + len(case.anchor))
    assert quote["anchor_text"] == case.anchor
    await _seed_note(db_session, user_id, entry_id, stored, case.anchor)

    new_stored, quote, note = await _anchors_after_patch(
        async_client, headers, entry_id, _edited(case, stored)
    )

    assert quote["stale"] is False
    assert new_stored[quote["anchor_start"] : quote["anchor_end"]] == case.anchor
    assert quote["anchor_start"] > start
    assert note["status"] == MarginaliaStatus.ACTIVE
    assert new_stored[note["anchor_start"] : note["anchor_end"]] == case.anchor


@pytest.mark.asyncio
@pytest.mark.parametrize("case", _SURVIVING_EDITS, ids=lambda c: c.name)
async def test_formatting_the_anchor_itself_marks_both_stale(
    async_client: AsyncClient, db_session: AsyncSession, case: EditCase
) -> None:
    """Wrapping part of the anchored text in new delimiters detaches it honestly."""
    headers, user_id = await _signup(async_client, "stale-" + case.name.replace(" ", "-"))
    entry_id, stored = await _create(async_client, headers, case.typed)
    start = stored.index(case.anchor)
    await _promote(async_client, headers, entry_id, start, start + len(case.anchor))
    await _seed_note(db_session, user_id, entry_id, stored, case.anchor)
    # Split the anchor with a delimiter pair, so its text no longer occurs anywhere.
    split = start + len(case.anchor) // 2
    new_body = stored[:split] + "**" + stored[split:]

    new_stored, quote, note = await _anchors_after_patch(async_client, headers, entry_id, new_body)

    assert case.anchor not in new_stored
    assert quote["stale"] is True
    assert note["status"] == MarginaliaStatus.STALE


@pytest.mark.asyncio
async def test_promote_over_stored_unicode_body_snapshots_its_exact_slice(
    async_client: AsyncClient,
) -> None:
    """Over the STORED (composed, trimmed) body, anchor_text is exactly the slice."""
    headers, _user_id = await _signup(async_client, "exact-slice")
    typed = f"\n  Cafe{_ACUTE} {_EMOJI} by **the river**  \n"
    entry_id, stored = await _create(async_client, headers, typed)
    assert stored != typed  # the server composed and trimmed it
    start = stored.index("by **the")
    end = stored.index("river**") + len("river**")

    quote = await _promote(async_client, headers, entry_id, start, end)

    assert quote["anchor_text"] == stored[start:end]
    assert quote["anchor_end"] - quote["anchor_start"] == len(quote["anchor_text"])


async def _promote_then_prefix(
    client: AsyncClient, username: str, start_pad: int, end_pad: int
) -> tuple[dict[str, Any], dict[str, Any], int]:
    """Promote the second "word" widened by the pads, then PATCH a prefix in.

    Returns the promote response, the quote after the edit, and where the
    promoted "word" sits in the edited body.
    """
    headers, _user_id = await _signup(client, username)
    entry_id, stored = await _create(client, headers, "word one, and word two")
    second = stored.rindex("word")
    quote = await _promote(
        client, headers, entry_id, second - start_pad, second + len("word") + end_pad
    )
    resp = await client.patch(
        f"/journal/{entry_id}", json={"message": "So: " + stored}, headers=headers
    )
    assert resp.status_code == HTTPStatus.OK
    moved = (await client.get(f"/journal/{entry_id}/promotions", headers=headers)).json()[0]
    return quote, moved, second + len("So: ")


@pytest.mark.asyncio
async def test_whitespace_edged_span_is_stored_verbatim_but_snapshot_trimmed(
    async_client: AsyncClient,
) -> None:
    """Pin the server half of why the client trims a selection's edges.

    The server keeps the posted offsets but trims the snapshot, so a span with a
    trailing space stores ``anchor_end - anchor_start == len(anchor_text) + 1``.
    Its start still spells the text, so an edit before it shifts the quote with
    its own word (#2945 -- it no longer jumps to the FIRST "word") and the
    re-anchor rewrites the end to ``start + len(anchor_text)``.
    """
    quote, moved, own_word = await _promote_then_prefix(async_client, "edge-space", 0, 1)
    assert quote["anchor_text"] == "word"
    assert quote["anchor_end"] - quote["anchor_start"] == len("word ")

    assert moved["stale"] is False
    assert (moved["anchor_start"], moved["anchor_end"]) == (own_word, own_word + len("word"))


@pytest.mark.asyncio
async def test_leading_whitespace_span_on_repeated_word_goes_stale_on_edit(
    async_client: AsyncClient,
) -> None:
    """A leading-space span's start does not spell its text, so its copy is unprovable.

    With "word" occurring twice the server cannot tell which copy the quote
    meant, so the first edit marks it stale rather than guessing -- the reason
    ``trimAnchorEdges`` must trim the leading edge on the client.
    """
    quote, moved, _own_word = await _promote_then_prefix(async_client, "edge-lead", 1, 0)
    assert quote["anchor_text"] == "word"

    assert moved["stale"] is True
    assert moved["anchor_start"] == quote["anchor_start"]
