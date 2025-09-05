from src.domain.goals import compute_progress


def test_additive_progress() -> None:
    progress, code = compute_progress(5, 10, is_additive=True)
    assert code == "additive_progress"
    assert progress == 0.5  # noqa: PLR2004


def test_subtractive_progress() -> None:
    progress, code = compute_progress(3, 10, is_additive=False)
    assert code == "subtractive_progress"
    assert progress == 0.7  # noqa: PLR2004
