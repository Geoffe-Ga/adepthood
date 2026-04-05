"""Tests for the errors helper module."""

from __future__ import annotations

from fastapi import HTTPException, status

from errors import bad_request, forbidden, not_found


def test_not_found_returns_404_with_resource_detail() -> None:
    exc = not_found("habit")
    assert isinstance(exc, HTTPException)
    assert exc.status_code == status.HTTP_404_NOT_FOUND
    assert exc.detail == "habit_not_found"


def test_forbidden_returns_403_with_default_detail() -> None:
    exc = forbidden()
    assert isinstance(exc, HTTPException)
    assert exc.status_code == status.HTTP_403_FORBIDDEN
    assert exc.detail == "forbidden"


def test_forbidden_returns_403_with_custom_reason() -> None:
    exc = forbidden("not_owner")
    assert isinstance(exc, HTTPException)
    assert exc.status_code == status.HTTP_403_FORBIDDEN
    assert exc.detail == "not_owner"


def test_bad_request_returns_400_with_reason() -> None:
    exc = bad_request("user_already_exists")
    assert isinstance(exc, HTTPException)
    assert exc.status_code == status.HTTP_400_BAD_REQUEST
    assert exc.detail == "user_already_exists"
