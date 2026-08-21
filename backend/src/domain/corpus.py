"""How a corpus fragment is scored against a query, as pure arithmetic.

Retrieval ranks on two independent axes and this module is both of them,
separated from the query that fetches candidates so each can be asserted at
exact values.

**Similarity is what the writing is about.** Cosine between the query's
embedding and the fragment's. Signed, deliberately: the opposite direction is
``-1``, not ``0``, so :data:`MIN_SIMILARITY` can tell "about the opposite
thing" from "about nothing in particular". Two vectors that cannot be compared
— different widths, or either one with no direction at all — produce ``None``
rather than a number. That distinction is the reason this returns an optional:
a fabricated similarity is indistinguishable from a real one at the call site,
and would quietly rank an uncomparable fragment among comparable ones.

**Affinity is where on the ten-fold ontology the writing sits.** One entry read
out of the fragment's own weights, at the frequency the caller asked to be
biased toward. This is the axis that makes retrieval "calibrated to where you
are right now" rather than merely topical (NORTH-STAR §2): semantic similarity
alone returns writing about approximately the right subject in generic shape,
which is the failure the ontology exists to prevent.

Weights are read under the ``F1``..``F10`` codes of :mod:`domain.frequencies`
because that is how they are persisted, and codes rather than names because the
labelings of these ten positions diverge — the join across vocabularies is on
colour, never on a name.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence

from domain.frequencies import Frequency

# How the two axes trade off when both are available. They sum to one so a
# blended score stays on the same scale as either axis alone, which is what
# lets a caller compare a bias-only retrieval's numbers with a two-axis one's.
SIMILARITY_WEIGHT = 0.6
FREQUENCY_WEIGHT = 0.4

# Below this cosine, a fragment is not about the query and no amount of
# on-frequency confidence should promote it into a grounding prompt. Set well
# above zero (unrelated) and well below the ~0.7 an obvious paraphrase scores,
# so it excludes the topically absent without demanding near-duplication.
MIN_SIMILARITY = 0.2


def _magnitude(vector: Sequence[float]) -> float:
    """Euclidean length of a vector."""
    return math.sqrt(sum(value * value for value in vector))


def _dot_product(left: Sequence[float], right: Sequence[float]) -> float:
    """Dot product of two vectors already known to be the same width."""
    return sum(a * b for a, b in zip(left, right, strict=True))


def cosine_similarity(left: Sequence[float], right: Sequence[float]) -> float | None:
    """Cosine of the angle between two embeddings, or ``None`` if there is none.

    ``None`` means *not comparable*, and there are exactly two ways to get it:
    the vectors have different widths, or one of them is the zero vector and so
    points nowhere. Neither is an error — an embedding provider changing
    dimensions mid-corpus is an ordinary migration state — but neither has an
    answer either, and returning ``0.0`` for them would claim "unrelated" about
    a pair nothing was measured on.
    """
    if len(left) != len(right) or not left:
        return None
    left_magnitude = _magnitude(left)
    right_magnitude = _magnitude(right)
    if left_magnitude == 0.0 or right_magnitude == 0.0:
        return None
    return _dot_product(left, right) / (left_magnitude * right_magnitude)


def frequency_affinity(weights: Mapping[str, float], bias: Frequency | None) -> float:
    """How strongly a fragment carries the frequency the caller asked for.

    ``0.0`` when no bias was asked for, and ``0.0`` for a frequency the
    fragment does not carry — the weights omit absent frequencies rather than
    listing them at zero, so a missing key and a zero weight mean the same
    thing and are treated the same way.
    """
    if bias is None:
        return 0.0
    return float(weights.get(bias.value, 0.0))


def blend_score(*, similarity: float | None, affinity: float) -> float:
    """Combine the two axes into the number fragments are ordered by.

    With both axes present the score is their weighted sum. With no similarity
    the affinity carries the score *unscaled*: multiplying the sole surviving
    axis by ``FREQUENCY_WEIGHT`` would shrink every score in a bias-only
    retrieval for no reason other than the absence of a second term.
    """
    if similarity is None:
        return affinity
    return SIMILARITY_WEIGHT * similarity + FREQUENCY_WEIGHT * affinity
