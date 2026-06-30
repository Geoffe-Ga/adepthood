"""Non-clinical care resources surfaced on an acute-distress signal.

Pure, reviewable, localizable data — no FastAPI, no DB, no network, no LLM.
When the resonance pass screens an entry as carrying an acute-distress signal
(:func:`domain.safety.assess_distress`), the care surface must accompany — and
never be replaced by — the AI's reflection, so a distressed person is pointed at
**human and professional** support rather than left alone with a chatbot
(NORTH-STAR §10).

What this is, and is not
------------------------
These are *pointers*, not care: a warm, non-shaming invitation plus a short,
auditable list of ways to reach a person (988, Crisis Text Line, someone you
trust) and a professional. There is **no diagnosis, no medication guidance, no
treatment advice** here — that belongs to a person and their prescriber, not to
software. The copy is gathered into module constants precisely so it can be
reviewed and localized in one place rather than scattered through a handler.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

CareKind = Literal["hotline", "text_line", "human", "professional"]


@dataclass(frozen=True)
class CareResource:
    """One support pointer: a name, how to reach it, and what it is.

    ``kind`` distinguishes the routing — ``hotline``/``text_line`` are immediate
    crisis lines, ``human`` points at a trusted person, ``professional`` at
    clinical care. Pure data: nothing here diagnoses or advises on medication.
    """

    kind: CareKind
    name: str
    contact: str
    what_it_is: str


@dataclass(frozen=True)
class CarePayload:
    """The full care surface: a warm message plus the structured resources.

    Returned alongside (never instead of) the resonance reflection when an entry
    screens as elevated, so the response is never *only* AI-generated text.
    """

    message: str
    resources: tuple[CareResource, ...]


# A warm, non-shaming invitation. It names that reaching a person matters and
# explicitly does not frame distress as a failure (NORTH-STAR §10). No diagnosis,
# no medication or treatment advice — only an invitation toward human contact.
CARE_MESSAGE = (
    "Reading this, I want to make sure you're not carrying it alone. "
    "What you're feeling is real, and it does not make you a failure — "
    "it makes you human. You don't have to face this moment by yourself, "
    "and reaching out to a person is a sign of strength, not weakness. "
    "The people below are there for exactly this, any time, and so is "
    "someone you trust."
)

# Human + professional support pointers. Order leads with the immediate crisis
# lines, then a trusted person, then professional care. Pure pointers — no
# diagnosis, no medication or treatment guidance.
CARE_RESOURCES: tuple[CareResource, ...] = (
    CareResource(
        kind="hotline",
        name="988 Suicide & Crisis Lifeline",
        contact="Call or text 988",
        what_it_is=(
            "Free, confidential support from a trained human counselor, "
            "24 hours a day, 7 days a week."
        ),
    ),
    CareResource(
        kind="text_line",
        name="Crisis Text Line",
        contact="Text HOME to 741741",
        what_it_is=(
            "Text back and forth with a trained volunteer crisis counselor, any time, for free."
        ),
    ),
    CareResource(
        kind="human",
        name="Someone you trust",
        contact="Reach out to a friend, family member, or anyone you trust",
        what_it_is=(
            "You don't have to explain it perfectly — telling one person you're "
            "struggling can make this moment less heavy."
        ),
    ),
    CareResource(
        kind="professional",
        name="A mental-health professional",
        contact="Contact a therapist, counselor, or your doctor",
        what_it_is=(
            "A professional can offer ongoing, personal support. This app builds "
            "skill and self-knowledge alongside that care — it never replaces it."
        ),
    ),
)


def build_care_payload() -> CarePayload:
    """Return the care surface (warm message + human and professional pointers).

    Pure and deterministic: the same reviewable, localizable constants every
    time, derived from nothing user-specific so it can never leak across users.
    Contains no diagnosis, no medication guidance, and no treatment advice.
    """
    return CarePayload(message=CARE_MESSAGE, resources=CARE_RESOURCES)
