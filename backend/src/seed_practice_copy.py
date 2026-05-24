"""Long-form ``description`` and ``instructions`` text for the catalog presets.

Split from :mod:`seed_practices` so the seeder logic stays small and the
product-editable copy lives in a flat, diff-friendly data module.

Each entry maps a preset *name* to a ``(description, instructions)`` tuple.
Keying by name (rather than stage number) lets a single stage carry more
than one preset — e.g. the stage-1 grounding alternatives. Lengths stay
under the ``Practice`` model's column caps
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


#: Stage 1 alternative — Touch Grass (mindful_anchor mode).
_TOUCH_GRASS = (
    "A single-action grounding practice: stand barefoot on a natural "
    "surface and let its texture and temperature draw you into the "
    "present moment.",
    "Find a patch of grass, soil, sand, or stone where you can safely "
    "stand barefoot. Take off your shoes. Plant both feet and let your "
    "weight settle. Notice the texture, the temperature, and the pressure "
    "where your soles meet the earth. There is nothing to accomplish — "
    "stay until you feel settled, then mark the practice complete.",
)

#: Stage 1 alternative — Mindful Eating (mindful_anchor mode).
_MINDFUL_EATING = (
    "A single-action mindful-presence practice: eat one small portion of "
    "a grounding food slowly, giving full attention to every sense.",
    "Choose one small portion of a grounding food and sit down with it. "
    "Before the first bite, take in its colour, shape, and aroma. Eat "
    "slowly: attend to texture, temperature, and flavour, and pause "
    "between bites to let each one finish. When the portion is gone, sit "
    "with the aftertaste for a moment before marking the practice complete.",
)

#: Stage 1 alternative — Find Shapes (tallied_grounding mode).
_FIND_SHAPES = (
    "A grounding technique that anchors you in the present by hunting "
    "your surroundings for everyday geometric shapes.",
    "Look around wherever you are. Each round, find three squares, then "
    "three triangles, then three circles — pointing to or naming each "
    "one as you spot it. Finish all three shapes before starting the "
    "next round. Three rounds in all.",
)

#: Stage 1 alternative — Find Colors (tallied_grounding mode).
_FIND_COLORS = (
    "A grounding technique that anchors you in the present by sweeping "
    "your surroundings for each colour of the rainbow.",
    "Look around wherever you are. Each round, find one thing for every "
    "colour of the rainbow in order — red, orange, yellow, green, blue, "
    "indigo, violet — naming each as you spot it. Finish the full "
    "spectrum before starting the next round. Three rounds in all.",
)


PRESET_COPY: dict[str, tuple[str, str]] = {
    "5-4-3-2-1 grounding": _S1,
    "Tarot meditation": _S2,
    "Belly breathing": _S3,
    "Metta": _S4,
    "Wim Hof method": _S5,
    "Shadow work": _S6,
    "Blissy meditation": _S7,
    "Dog Walkin' Shamanism": _S8,
    "Concentration practice": _S9,
    "Insight practice": _S10,
    "Touch Grass": _TOUCH_GRASS,
    "Mindful Eating": _MINDFUL_EATING,
    "Find Shapes": _FIND_SHAPES,
    "Find Colors": _FIND_COLORS,
}
