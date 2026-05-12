"""Long-form ``description`` and ``instructions`` text for the 10 stage presets.

Split from :mod:`seed_practices` so the seeder logic stays small and the
product-editable copy lives in a flat, diff-friendly data module.

Each entry maps a stage number to a ``(description, instructions)`` tuple.
Lengths stay under the ``Practice`` model's column caps
(description ≤ 2000 chars, instructions ≤ 10000 chars).
"""

from __future__ import annotations

#: Stage 1 — 5-4-3-2-1 sensory grounding (sense_grounding mode).
_S1 = (
    "A grounding technique that anchors you in the present by inventorying "
    "what each sense is reporting right now.",
    "Sit or stand. For each sense in order, name the listed number of "
    "specific things you can perceive — out loud or in your head. Move on "
    "to the next sense only when you've completed the current one. "
    "Five things you can see, four you can touch, three you can hear, "
    "two you can smell, one you can taste.",
)

#: Stage 2 — Tarot meditation on the major arcana (tarot mode).
_S2 = (
    "Sit with one card of the Major Arcana per day for five minutes, "
    "progressing from The Fool to The World over 22 days.",
    "Find a quiet seat. Bring the card to mind (or place it before you) "
    "and let the image speak. Do not analyse — observe what arises in "
    "body, feeling, and thought. The timer is hidden during the meditation "
    "so you can rest in the image; it reappears at the bell.",
)

#: Stage 3 — Belly breathing (meditation_timer).
_S3 = (
    "Ten minutes of diaphragmatic breathing to settle the nervous system.",
    "Sit upright with one hand on the belly. Inhale slowly through the "
    "nose, feeling the hand rise as the diaphragm drops. Exhale through "
    "pursed lips, twice as long as the inhale if comfortable. Continue "
    "until the closing bell.",
)

#: Stage 4 — Metta / loving-kindness (meditation_timer).
_S4 = (
    "Fifteen minutes of loving-kindness practice across widening circles.",
    "Begin with yourself. Silently offer the four phrases — may I be safe, "
    "may I be happy, may I be healthy, may I live with ease. When the "
    "halfway bell sounds, widen to someone you love, then to a neutral "
    "person, then to someone difficult, then to all beings.",
)

#: Stage 5 — Wim Hof method (meditation_timer).
_S5 = (
    "Twenty minutes of cyclic hyperventilation with retention rounds, followed by quiet rest.",
    "Take 30-40 deep, full breaths in through the nose or mouth, exhaling "
    "passively. After the final exhale, hold without breath until the "
    "natural urge returns; then inhale fully and hold for 15 seconds. "
    "Repeat three rounds, then rest in the stillness that follows.",
)

#: Stage 6 — Shadow work with metronome (metronome mode).
_S6 = (
    "Thirty minutes of shadow-confronting reflection paced by a metronome.",
    "Set an intention to meet a part of yourself you usually turn away "
    "from. Let the metronome's tick keep you from drifting into "
    "rumination — each click is a return to bare attention. When the "
    "halfway bell sounds, ask what this part wants you to know.",
)

#: Stage 7 — Blissy meditation (meditation_timer).
_S7 = (
    "Forty-five minutes resting in the field of subtle pleasure.",
    "Sit comfortably. Locate any background sensation of contentment, "
    "ease, or pleasantness — however faint. Rest attention there, letting "
    "the feeling broaden by being noticed rather than chased.",
)

#: Stage 8 — Dog Walkin' Shamanism (count_up).
_S8 = (
    "An open-ended walking practice: take the dog (or yourself) out, "
    "and let the world's signs speak.",
    "Walk without a destination. Notice what catches your attention — a "
    "bird, a license plate, a colour, a phrase overheard. Treat each as a "
    "message worth holding lightly. End when you feel complete; the timer "
    "counts up to honour the open container.",
)

#: Stage 9 — Concentration practice (meditation_timer).
_S9 = (
    "Forty-five minutes single-pointed attention on one object.",
    "Choose a single object — breath at the nostrils, a kasina, or a "
    "phrase. When you notice the mind has wandered, return without "
    "comment. The halfway bell is your invitation to refresh the choice.",
)

#: Stage 10 — Insight practice (meditation_timer).
_S10 = (
    "Forty-five minutes of open awareness, watching the three characteristics arise and pass.",
    "Begin grounded in the body. Open the field to whatever is present — "
    "sensation, sound, thought — and notice how each arises, persists, "
    "and dissolves. The work is not to control but to see clearly.",
)


PRESET_COPY: dict[int, tuple[str, str]] = {
    1: _S1,
    2: _S2,
    3: _S3,
    4: _S4,
    5: _S5,
    6: _S6,
    7: _S7,
    8: _S8,
    9: _S9,
    10: _S10,
}
