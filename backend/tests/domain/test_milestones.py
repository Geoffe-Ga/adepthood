from src.domain.milestones import achieved_milestones


def test_milestones() -> None:
    reached, code = achieved_milestones(7, [3, 5, 10])
    assert code == "milestones_achieved"
    assert reached == [3, 5]
