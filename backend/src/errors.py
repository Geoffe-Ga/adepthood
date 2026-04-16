"""Standardized HTTP error helpers for consistent API responses."""

from __future__ import annotations

from fastapi import HTTPException, status


def not_found(resource: str) -> HTTPException:
    """Return a 404 HTTPException with a snake_case detail."""
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{resource}_not_found")


def forbidden(reason: str = "forbidden") -> HTTPException:
    """Return a 403 HTTPException."""
    return HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=reason)


def bad_request(reason: str) -> HTTPException:
    """Return a 400 HTTPException."""
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=reason)


def conflict(reason: str) -> HTTPException:
    """Return a 409 HTTPException for state conflicts."""
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=reason)


def payment_required(reason: str = "payment_required") -> HTTPException:
    """Return a 402 HTTPException for insufficient credits."""
    return HTTPException(status_code=status.HTTP_402_PAYMENT_REQUIRED, detail=reason)
