"""A module whose tests never run, in the two spellings that arrange that."""

import pytest


@pytest.mark.skip(reason="stands in for a row's evidence that never executes")
def test_skipped() -> None:
    """Stand in for a disabled row."""


@pytest.mark.skipif(True, reason="stands in for a conditionally disabled row")
def test_conditionally_skipped() -> None:
    """Stand in for a conditionally disabled row."""
