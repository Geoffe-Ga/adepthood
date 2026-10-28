"""Read an ``application/x-www-form-urlencoded`` body the way OAuth requires.

The consent page's forms post this encoding (#3532), and so does every client
calling the token endpoint (#3533) -- Claude sends nothing else, and answering
it with a JSON-only parser's ``415`` breaks the connector. Starlette's form
parser needs an optional parsing package even for the urlencoded case, and this
app deliberately installs none (it accepts no file uploads), so the body is
parsed here with the standard library instead, under three rules OAuth and this
API both want:

* **The right encoding or nothing.** A body of any other media type is refused
  rather than guessed at.
* **A ceiling.** :data:`MAX_FORM_BYTES` -- every field these forms carry fits
  many times over -- enforced while the body streams in, so an oversized body
  costs this server the ceiling and no more.
* **One value per name.** RFC 6749 section 3.1 forbids repeating a parameter; a
  repeated one is refused rather than resolved, since "first wins" and "last
  wins" are both a choice an attacker could exploit.
"""

from __future__ import annotations

from typing import Final
from urllib.parse import parse_qsl

from starlette.requests import Request

#: The one media type these endpoints read.
FORM_MEDIA_TYPE: Final = "application/x-www-form-urlencoded"

#: The largest body read, in bytes.
MAX_FORM_BYTES: Final = 16 * 1024

#: The most fields one form may carry: every field the consent and token
#: endpoints read, with room for the extras clients add.
MAX_FORM_FIELDS: Final = 32


def single_valued(pairs: list[tuple[str, str]]) -> dict[str, str] | None:
    """Return ``pairs`` as a mapping, or ``None`` if any name appears twice."""
    values = dict(pairs)
    return values if len(values) == len(pairs) else None


def _media_type(request: Request) -> str:
    """The request's media type without parameters, lowercased."""
    return request.headers.get("content-type", "").split(";", 1)[0].strip().lower()


async def read_form(request: Request) -> dict[str, str] | None:
    """Return the request's form fields, or ``None`` if the body is not one OAuth accepts."""
    if _media_type(request) != FORM_MEDIA_TYPE:
        return None
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_FORM_BYTES:
            return None
    try:
        pairs = parse_qsl(
            body.decode(),
            keep_blank_values=True,
            strict_parsing=False,
            max_num_fields=MAX_FORM_FIELDS,
        )
    except (UnicodeDecodeError, ValueError):
        return None
    return single_valued(pairs)
