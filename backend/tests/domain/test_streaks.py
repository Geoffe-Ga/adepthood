from domain.streaks import update_streak


def test_streak_increment() -> None:
    new_streak, code = update_streak(3, True)
    assert new_streak == 4  # noqa: PLR2004
    assert code == "streak_incremented"


def test_streak_reset() -> None:
    new_streak, code = update_streak(5, False)
    assert new_streak == 0
    assert code == "streak_reset"
