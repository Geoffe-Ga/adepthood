from domain.streaks import update_streak


def test_streak_increment() -> None:
    new_streak, code = update_streak(3, did_check_in=True)
    assert new_streak == 4
    assert code == "streak_incremented"


def test_streak_reset() -> None:
    new_streak, code = update_streak(5, did_check_in=False)
    assert new_streak == 0
    assert code == "streak_reset"
