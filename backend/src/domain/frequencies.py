"""The APTITUDE frequency ontology — F1..F10, and nothing else.

This vocabulary is **shared with Creek**, which declares it with
``extra="forbid"`` and notes that "an eleventh frequency is a change to the
shared ontology vocabulary — a contract change with a version bump". The set
here is therefore fixed by contract, not by convenience: adding, renaming or
dropping a member is a contract change, and callers treat an unrecognised code
as a protocol error rather than something to coerce.

It is vendored rather than imported. Creek's classifier lives in another
repository and is coupled to the vault's on-disk fragment layout, so importing
it would drag that layout in; re-deriving the names at each call site is
exactly what ``extra="forbid"`` exists to prevent. Vendoring the table — the
same posture as ``backend/tests/fixtures/creek_v1/`` — keeps one spelling in
one place.

**This is not the curriculum's Aspects.** ``services.creek_vault_client`` makes
the argument in full at its ``_WHEEL_FREQUENCY_CODES`` definition: creek
publishes a distribution over its classified corpus, adepthood renders per-stage
Aspect fullness from the 36-week curriculum, and "creek's ``Agency`` is not a
course Aspect". Both happen to have ten members, which that comment correctly
calls a coincidence of cardinality. This module owns the ontology half of that
pair; :mod:`curriculum` owns the other.

That coincidence is also why this module exists rather than the codes staying
where they were. ``_WHEEL_FREQUENCY_CODES`` derived its whitelist from
``TOTAL_STAGES`` — a curriculum quantity — so a curriculum that grew to twelve
stages would have silently begun accepting ``F11`` and ``F12``, admitting two
frequencies the shared ontology forbids. Deriving the whitelist from the
ontology instead makes the two independent, as its own comment argues they are.
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
