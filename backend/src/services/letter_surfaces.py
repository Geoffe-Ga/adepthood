"""What a vault letter says beside its text: whose voice, and which of the writer's pages (#3778).

Creek 0.35 reports whether a letter was written in the owner's own voice, and
0.36 names the praxis, eddies and threads its entry touches. Both are kept on
the margin note beside the cached letter -- the voice in plain text (a closed
vocabulary) and the pages as encrypted JSON (they are the writer's own words)
-- so reopening the letter shows exactly what it showed when it arrived, with
no second call to the vault.

Only a vault letter carries any of this: the app provider's letters are stamped
with nothing, so nothing renders beside them.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field

from domain.creek_vault import VaultLetter
from domain.vault_related import VaultReplyVoice
from models.marginalia import Marginalia
from services.creek_vault_reflect import VaultRelatedSurfaces


@dataclass(frozen=True)
class LetterSurfaces:
    """The voice a vault letter was written in, and the writer's pages beside it."""

    voice: VaultReplyVoice | None = None
    related: VaultRelatedSurfaces = field(default_factory=VaultRelatedSurfaces)

    @classmethod
    def of(cls, letter: VaultLetter) -> LetterSurfaces:
        """Read both off a verified vault letter."""
        return cls(
            voice=letter.voice,
            related=VaultRelatedSurfaces(
                praxis=letter.related_praxis,
                eddies=letter.related_eddies,
                threads=letter.related_threads,
            ),
        )


def _encoded_related(related: VaultRelatedSurfaces) -> str | None:
    """The pages as JSON :class:`~schemas.marginalia.LetterRelatedResponse` reads, or ``None``.

    ``None`` when the vault named no page at all, so a letter beside nothing
    stores nothing rather than an empty document.
    """
    if not (related.praxis or related.eddies or related.threads):
        return None
    return json.dumps(asdict(related))


def stamp_letter_surfaces(note: Marginalia, surfaces: LetterSurfaces) -> None:
    """Record ``surfaces`` on ``note`` beside its letter; the caller commits."""
    note.essay_voice = None if surfaces.voice is None else surfaces.voice.value
    note.essay_related = _encoded_related(surfaces.related)
