"""Journal titles are a single stored line on both create and update."""

from schemas.journal import JournalEntryUpdate, JournalMessageCreate


def test_create_collapses_title_line_breaks() -> None:
    payload = JournalMessageCreate(
        message="A body.",
        title="First line\r\nSecond line\n\nThird line",
    )

    assert payload.title == "First line Second line Third line"


def test_update_collapses_title_line_breaks() -> None:
    payload = JournalEntryUpdate(title="First line\rSecond line\nThird line")

    assert payload.title == "First line Second line Third line"


def test_null_title_remains_null() -> None:
    assert JournalMessageCreate(message="A body.", title=None).title is None
    assert JournalEntryUpdate(title=None).title is None
