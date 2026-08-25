"""Scoring for the ontologized corpus: the two axes and how they blend.

Retrieval ranks on two independent axes — semantic similarity to a query and
affinity to one of the ten frequencies — and the arithmetic that combines them
is the part a database cannot check. It lives in ``domain.corpus`` as pure
functions so it can be asserted at exact values rather than inferred from row
order.

The boundaries that matter here are the degenerate vectors. A zero vector has
no direction, and two vectors of different lengths are not comparable at all;
both must produce "no answer" rather than a number, because a silently wrong
similarity is indistinguishable from a right one at the call site.
"""

from __future__ import annotations

import math

import pytest

from domain.corpus import (
    FREQUENCY_WEIGHT,
    MIN_SIMILARITY,
    SIMILARITY_WEIGHT,
    blend_score,
    cosine_similarity,
    frequency_affinity,
)
from domain.frequencies import Frequency


def test_identical_vectors_are_perfectly_similar() -> None:
    """Cosine of a vector with itself is exactly one."""
    assert cosine_similarity((1.0, 2.0, 3.0), (1.0, 2.0, 3.0)) == pytest.approx(1.0)


def test_orthogonal_vectors_are_not_similar_at_all() -> None:
    """Perpendicular directions share nothing, which is exactly zero."""
    assert cosine_similarity((1.0, 0.0), (0.0, 1.0)) == pytest.approx(0.0)


def test_opposed_vectors_score_below_zero() -> None:
    """Cosine is signed: the opposite direction is -1, not 0.

    Asserted because clamping the negative half to zero would make "opposite
    meaning" and "unrelated meaning" the same score, and the similarity
    threshold could then never tell them apart.
    """
    assert cosine_similarity((1.0, 0.0), (-1.0, 0.0)) == pytest.approx(-1.0)


def test_a_known_angle_gives_its_known_cosine() -> None:
    """A 45-degree pair scores ``1/sqrt(2)`` — a value, not merely "positive"."""
    assert cosine_similarity((1.0, 0.0), (1.0, 1.0)) == pytest.approx(1 / math.sqrt(2))


def test_vectors_of_different_lengths_have_no_similarity() -> None:
    """Two embeddings of different dimensionality are not comparable.

    ``None`` rather than a number: zip-and-truncate would return a plausible
    score for a pair that cannot be compared, which is the worst of the three
    possible answers.
    """
    assert cosine_similarity((1.0, 2.0), (1.0, 2.0, 3.0)) is None


def test_a_zero_vector_has_no_similarity() -> None:
    """A zero vector has no direction, so there is no angle to measure."""
    assert cosine_similarity((0.0, 0.0), (1.0, 1.0)) is None


def test_an_empty_vector_has_no_similarity() -> None:
    """The empty embedding is the zero vector's degenerate cousin."""
    assert cosine_similarity((), ()) is None


def test_affinity_is_the_fragments_weight_at_the_biased_frequency() -> None:
    """The bias reads one entry out of the fragment's own weights."""
    weights = {Frequency.F5.value: 0.9, Frequency.F3.value: 0.2}

    assert frequency_affinity(weights, Frequency.F5) == pytest.approx(0.9)


def test_a_frequency_the_fragment_does_not_carry_scores_zero() -> None:
    """Weights omit absent frequencies rather than listing them at zero."""
    assert frequency_affinity({Frequency.F5.value: 0.9}, Frequency.F6) == pytest.approx(0.0)


def test_no_bias_means_no_affinity_contribution() -> None:
    """With nothing asked for, every fragment is equally on-frequency."""
    assert frequency_affinity({Frequency.F5.value: 0.9}, None) == pytest.approx(0.0)


def test_the_blend_weights_similarity_and_affinity_at_their_constants() -> None:
    """The blended score is exactly the weighted sum, at named constants."""
    blended = blend_score(similarity=0.5, affinity=0.25)

    assert blended == pytest.approx(SIMILARITY_WEIGHT * 0.5 + FREQUENCY_WEIGHT * 0.25)


def test_the_blend_falls_back_to_affinity_when_there_is_no_similarity() -> None:
    """Without a query embedding there is only one axis, and it carries the score.

    Not ``FREQUENCY_WEIGHT * affinity``: scaling the sole axis down would make
    every score in a bias-only retrieval smaller for no reason, and the numbers
    are compared against ``MIN_SIMILARITY``-style thresholds by callers.
    """
    assert blend_score(similarity=None, affinity=0.25) == pytest.approx(0.25)


def test_the_two_axis_weights_sum_to_one() -> None:
    """A blend of two weights that do not sum to one is not a blend."""
    total = SIMILARITY_WEIGHT + FREQUENCY_WEIGHT

    assert total == pytest.approx(1.0)


def test_the_similarity_threshold_sits_inside_the_cosine_range() -> None:
    """A threshold outside ``[-1, 1]`` would admit everything or nothing."""
    assert MIN_SIMILARITY > -1.0
    assert MIN_SIMILARITY < 1.0
