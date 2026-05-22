"""Practice mode discriminator shared by catalog rows and per-user overrides.

A practice's *mode* selects which engine drives the session and which set of
config fields the catalog row carries. The values here are the wire format —
they're stored as plain strings in the ``practice.mode`` column and emitted
verbatim in API responses so the frontend can branch on them without a
translation table.
"""

from __future__ import annotations

from enum import StrEnum


class PracticeMode(StrEnum):
    """Closed enumeration of ritual modes supported by the engine."""

    MEDITATION_TIMER = "meditation_timer"
    COUNT_UP = "count_up"
    METRONOME = "metronome"
    INTERVAL_BELL = "interval_bell"
    REP_COUNTER = "rep_counter"
    SENSE_GROUNDING = "sense_grounding"
    TAROT = "tarot"
    TALLIED_GROUNDING = "tallied_grounding"
    MINDFUL_ANCHOR = "mindful_anchor"
    CARD_MEDITATION = "card_meditation"
    RANDOM_INTERVAL_BELL = "random_interval_bell"


#: Ordered tuple of wire values, suitable for CHECK constraints and docs.
ALL_MODES: tuple[str, ...] = tuple(m.value for m in PracticeMode)
