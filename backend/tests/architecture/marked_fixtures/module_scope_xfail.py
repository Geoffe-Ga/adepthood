"""A module whose every test is expected to fail, marked once at the top."""

import pytest

pytestmark = pytest.mark.xfail(strict=True, reason="the whole module is a known-red row")


def test_it_releases_first() -> None:
    """Stand in for a row's runtime evidence."""
    raise AssertionError
