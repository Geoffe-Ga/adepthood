"""The ten Aspects of Wholeness — F1..F10, keyed by colour.

One set of ten developmental positions with four interchangeable names. They
are the **Aspects of Wholeness**, the **Frequencies**, the **Stages** and the
**Wavelength Modes**: not four vocabularies that happen to align, but one thing
the codebase and the course each learned to call by a different word.

``NORTH-STAR.md`` states the identity outright — "the shared ontology where
Adepthood's Aspects equal Creek's Frequencies equal the Wavelength Modes" — and
``graph/ontology-spine.md`` writes each row as an equation:
``Beige = Stage 1 = F1 = BEIGE = 01-beige = Survival``.

**Modes are not phases, and this is the confusion to guard against.** A Mode is
one of these ten, colour-keyed — Beige's Mode is Inhabit (Do), Clear Light's is
Be (Both/Neither), each named in its ``NN-colour`` chapter as "The Mode of the
Wavelength of <Colour>". The Wavelength *phases* are a different axis
altogether: six of them (Rising, Peaking, Withdrawal, Diminishing, Bottoming
Out, Restoration), a cycle every position moves through rather than a member of
the set of ten.

**Colour is the primary key.** Beige through Clear Light is the stable
identifier across every surface: the ``NN-colour`` content directories, the
``STAGE_COLORS`` design tokens, the habit ring, and the vault's wire codes. The
names drift between contexts — F3 is "Self-Love / Power" upstream, ``aspect``
"Self-Love" plus ``title`` "Power" in ``archetypal_wavelength.json``, and the
composite is literally those two joined — but the colour does not.

======  ============  ============================  ==================  ==================
Code    Colour        Aspect                        Title               Mode
======  ============  ============================  ==================  ==================
F1      Beige         Agency                        Survival            Inhabit (Do)
F2      Purple        Receptivity                   Magick              Inhabit (Feel)
F3      Red           Self-Love                     Power               Express (Do)
F4      Blue          Community Love                Conformity          Express (Feel)
F5      Orange        Intellectual Understanding    Achievist           Collaborate (Do)
F6      Green         Embodied Understanding        Pluralist           Collaborate (Feel)
F7      Yellow        Systems Wisdom                Integrative         Integrate (Do)
F8      Teal          True Self Connection          Nondual             Integrate (Feel)
F9      Ultraviolet   Unity                         Effortless Being    Absorb (Do/Feel)
F10     Clear Light   Emptiness                     Pure Awareness      Be (Both/Neither)
======  ============  ============================  ==================  ==================

**There are exactly ten, and more than ten still means these ten.** The habits
surface lets someone carry more than ten rings; those repeat the same Beige to
Clear Light cycle rather than extending the set (``HabitUtils.stageAtIndex``
takes the modulo, and negative carryover slots wrap backwards from Clear
Light). An eleventh *position* is a change to the shared ontology vocabulary —
Creek declares the set with ``extra="forbid"`` — and needs a contract version
bump, not a code change.

The vocabulary is vendored rather than imported because Creek's classifier
lives in another repository and is coupled to the vault's on-disk fragment
layout. This module is the backend's single spelling of the table; the
curriculum's own copy is ``curriculum/archetypal_wavelength.json``, and the two
must agree row for row.
"""

from __future__ import annotations

import enum
from types import MappingProxyType
from typing import Final


class Frequency(enum.StrEnum):
    """One of the ten APTITUDE frequencies.

    Codes, not names, are the wire form: the names carry spaces and slashes,
    and a rename upstream should not invalidate stored classifications. See the
    module docstring on why this set cannot grow without a contract version
    bump.
    """

    F1 = "F1"
    F2 = "F2"
    F3 = "F3"
    F4 = "F4"
    F5 = "F5"
    F6 = "F6"
    F7 = "F7"
    F8 = "F8"
    F9 = "F9"
    F10 = "F10"


# The human-readable name per code. Wrapped in MappingProxyType so the shared
# vocabulary cannot be mutated at runtime. Deliberately a module constant and
# never a dataclass field default -- a mappingproxy is unhashable, which breaks
# on Python 3.11, one of the three versions the compat matrix builds.
FREQUENCY_NAMES: Final[MappingProxyType[Frequency, str]] = MappingProxyType(
    {
        Frequency.F1: "Agency",
        Frequency.F2: "Receptivity",
        Frequency.F3: "Self-Love / Power",
        Frequency.F4: "Community Love / Conformity",
        Frequency.F5: "Achievism",
        Frequency.F6: "Pluralism",
        Frequency.F7: "Integration",
        Frequency.F8: "True Self / Transcendence",
        Frequency.F9: "Unity",
        Frequency.F10: "Emptiness",
    }
)

# The colour per code -- the primary key. Names differ between the vault, the
# curriculum dataset and the course content; the colour is what every surface
# agrees on, so it is what joins them. Spelled as the curriculum spells it
# (``spiral_dynamics_color``), which is also how ``STAGE_COLORS`` and the
# ``NN-colour`` content directories spell it.
FREQUENCY_COLORS: Final[MappingProxyType[Frequency, str]] = MappingProxyType(
    {
        Frequency.F1: "Beige",
        Frequency.F2: "Purple",
        Frequency.F3: "Red",
        Frequency.F4: "Blue",
        Frequency.F5: "Orange",
        Frequency.F6: "Green",
        Frequency.F7: "Yellow",
        Frequency.F8: "Teal",
        Frequency.F9: "Ultraviolet",
        Frequency.F10: "Clear Light",
    }
)


#: Every valid code, in canonical order. The whitelist any wire-facing parser
#: should check against, so an eleventh code from either side is ignored rather
#: than absorbed.
FREQUENCY_CODES: Final[tuple[str, ...]] = tuple(code.value for code in Frequency)


def frequency_table() -> str:
    """Render the vocabulary as ``F1 — Agency`` lines, one per frequency.

    Generated from :data:`FREQUENCY_NAMES` rather than written out again, so a
    prompt built from this cannot describe a different ontology than the parser
    accepts. A restatement in prose would be a second copy, and second copies
    are what this module exists to avoid.
    """
    return "\n".join(f"{code.value} — {FREQUENCY_NAMES[code]}" for code in Frequency)
