from domain.milestones import achieved_milestones


def test_milestones_default_old_value_returns_all_below() -> None:
    """Without an ``old_value`` the helper behaves like the legacy stub."""
    reached, code = achieved_milestones(7, [3, 5, 10])
    assert code == "milestones_achieved"
    assert reached == [3, 5]


def test_milestones_only_newly_crossed_returned() -> None:
    """Thresholds already crossed on a prior call are dropped."""
    reached, _ = achieved_milestones(10, [3, 5, 10], old_value=5)
    assert reached == [10]


def test_milestones_no_double_celebration() -> None:
    """A re-call with the same value returns nothing -- no re-celebration."""
    reached, _ = achieved_milestones(7, [3, 5, 10], old_value=7)
    assert reached == []


def test_milestones_sorted_ascending() -> None:
    """Output is sorted regardless of input order."""
    reached, _ = achieved_milestones(20, [10, 3, 7, 14], old_value=0)
    assert reached == [3, 7, 10, 14]
