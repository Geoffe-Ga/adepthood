"""What an agent may say about itself, and the rules every self-description is held to.

An OAuth client describes itself one of two ways (#3532): it POSTs a document to
the registration endpoint (RFC 7591), or its ``client_id`` is an ``https`` URL
that serves the same document (a Client ID Metadata Document, "CIMD"). Both
arrive here and are judged by one set of rules, so a client cannot be refused by
one door and admitted by the other.

This module is pure -- no database, no network -- so the rules can be read and
exercised alone. Fetching a document lives in
:mod:`services.oauth_metadata_fetch`; storing one in
:mod:`services.oauth_clients`.

**What is checked, and why.**

* Every redirect URI must be one
  :func:`~services.oauth_authorization.redirect_uri_is_registrable` accepts:
  ``https``, or plain ``http`` to this computer.
* The client is public: ``token_endpoint_auth_method`` may only be ``none``, and
  it may ask only for the code and refresh grants and the ``code`` response.
  Anything else is a client this server cannot serve, refused at the door
  rather than at the first token request.
* The name is shown to a person deciding whether to trust it, so it is held to
  what a person can read: no control or format characters (a right-to-left
  override can make ``Claude Code`` out of other letters), and no longer than
  the column.
* A metadata document's own ``client_id`` must equal the URL it was fetched
  from. Without that, any page could claim to describe any client.
"""

from __future__ import annotations

import enum
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final
from urllib.parse import SplitResult, urlsplit

from pydantic import ValidationError

from models.oauth_client import OAUTH_CLIENT_NAME_MAX_LENGTH, OAUTH_URI_MAX_LENGTH
from schemas.oauth import ClientMetadataDocument, ClientRegistrationRequest
from services.creek_vault_url_user import classify_user_vault_url_host
from services.oauth_authorization import (
    GRANT_TYPES,
    PUBLIC_CLIENT_AUTH_METHOD,
    RESPONSE_TYPE_CODE,
    redirect_uri_is_registrable,
)

#: The most redirect URIs one client may register. Real clients register one or
#: two; the ceiling bounds what every authorization request is matched against.
MAX_REDIRECT_URIS: Final = 10

_HTTPS: Final = "https"
# Unicode general categories starting with "C": control, format (which holds the
# bidirectional overrides), surrogate, private use and unassigned.
_INVISIBLE_CATEGORY_PREFIX: Final = "C"
_DOT_SEGMENTS: Final = frozenset({".", ".."})


class RegistrationRefusal(enum.StrEnum):
    """The RFC 7591 error codes a self-description is refused with."""

    INVALID_REDIRECT_URI = "invalid_redirect_uri"
    INVALID_CLIENT_METADATA = "invalid_client_metadata"


@dataclass(frozen=True)
class ClientMetadata:
    """A self-description that passed every rule: what will be stored and shown."""

    client_name: str
    redirect_uris: tuple[str, ...]
    logo_uri: str | None


@dataclass(frozen=True)
class MetadataRefusal:
    """Why a self-description was refused: an RFC code and a value-free sentence."""

    error: RegistrationRefusal
    description: str


def _name_is_readable(name: str) -> bool:
    """Whether every character of ``name`` is one a person can see."""
    return not any(
        unicodedata.category(character).startswith(_INVISIBLE_CATEGORY_PREFIX) for character in name
    )


def _clean_name(raw: str | None) -> str | None:
    """Return the display name with surrounding space removed, or ``None`` if refused.

    An absent or blank name is the empty string, which the consent page shows
    as an agent that did not give its name.
    """
    name = (raw or "").strip()
    if len(name) > OAUTH_CLIENT_NAME_MAX_LENGTH or not _name_is_readable(name):
        return None
    return name


def _logo_is_acceptable(logo_uri: str | None) -> bool:
    """An absent logo, or an ``https`` one that fits its column."""
    if logo_uri is None:
        return True
    return len(logo_uri) <= OAUTH_URI_MAX_LENGTH and logo_uri.startswith(f"{_HTTPS}://")


def _redirects_refusal(redirect_uris: Sequence[str]) -> MetadataRefusal | None:
    """Name what is wrong with the redirect list, or ``None`` if nothing is."""
    if not redirect_uris or len(redirect_uris) > MAX_REDIRECT_URIS:
        return MetadataRefusal(
            RegistrationRefusal.INVALID_REDIRECT_URI,
            f"register between 1 and {MAX_REDIRECT_URIS} redirect URIs",
        )
    if not all(redirect_uri_is_registrable(uri) for uri in redirect_uris):
        return MetadataRefusal(
            RegistrationRefusal.INVALID_REDIRECT_URI,
            "every redirect URI must be https, or http to localhost or 127.0.0.1",
        )
    return None


def _asks_only_for_the_code_flow(metadata: ClientRegistrationRequest) -> bool:
    """Whether the grants and response types are a subset of the authorization code flow."""
    grants = set(metadata.grant_types or GRANT_TYPES)
    responses = set(metadata.response_types or (RESPONSE_TYPE_CODE,))
    return grants <= set(GRANT_TYPES) and responses <= {RESPONSE_TYPE_CODE}


def _is_public_code_client(metadata: ClientRegistrationRequest) -> bool:
    """Whether the client asks only for what a public PKCE client may have."""
    auth_method = metadata.token_endpoint_auth_method or PUBLIC_CLIENT_AUTH_METHOD
    return auth_method == PUBLIC_CLIENT_AUTH_METHOD and _asks_only_for_the_code_flow(metadata)


def _public_client_refusal(metadata: ClientRegistrationRequest) -> MetadataRefusal | None:
    """Refuse a client that is not a public authorization-code client."""
    if _is_public_code_client(metadata):
        return None
    return MetadataRefusal(
        RegistrationRefusal.INVALID_CLIENT_METADATA,
        "only public clients using the authorization code grant with PKCE are supported",
    )


def validate_client_metadata(
    metadata: ClientRegistrationRequest,
) -> ClientMetadata | MetadataRefusal:
    """Judge one self-description, returning what to store or why it was refused.

    Redirects are judged first because they are the security-relevant field and
    have their own RFC code; then the client's kind; then what it calls itself.
    """
    refusal = _redirects_refusal(metadata.redirect_uris) or _public_client_refusal(metadata)
    if refusal is not None:
        return refusal
    name = _clean_name(metadata.client_name)
    if name is None or not _logo_is_acceptable(metadata.logo_uri):
        return MetadataRefusal(
            RegistrationRefusal.INVALID_CLIENT_METADATA,
            f"client_name must be readable text of at most {OAUTH_CLIENT_NAME_MAX_LENGTH} "
            "characters and logo_uri an https address",
        )
    return ClientMetadata(
        client_name=name,
        redirect_uris=tuple(metadata.redirect_uris),
        logo_uri=metadata.logo_uri,
    )


# --- client metadata documents ---------------------------------------------------


def _path_is_plain(path: str) -> bool:
    """A non-root path with no ``.`` or ``..`` segment, as the CIMD draft requires."""
    segments = path.split("/")[1:]
    return bool(path.strip("/")) and not _DOT_SEGMENTS.intersection(segments)


def _document_url_parts(client_id: str) -> SplitResult | None:
    """Parse a candidate document URL, refusing on sight what may never be fetched."""
    if len(client_id) > OAUTH_URI_MAX_LENGTH or "#" in client_id or "?" in client_id:
        return None
    try:
        parts = urlsplit(client_id)
        _ = parts.port
    except ValueError:
        return None
    return parts


def _host_is_public(parts: SplitResult) -> bool:
    """A host present, no userinfo, and not a private literal or a local-only name."""
    host = parts.hostname
    if not host or parts.username is not None:
        return False
    return classify_user_vault_url_host(host) is None


def is_metadata_document_client_id(client_id: str) -> bool:
    """Return whether ``client_id`` is a URL this server may fetch a document from.

    ``https`` with a path, no fragment, no query, no userinfo, no dot segments,
    and a host that is neither a private address literal nor a local-only name.
    A name is resolved and judged again when it is dialled
    (:mod:`services.creek_vault_pinned_transport`); this is the half that can be
    decided from the string, and it is decided before any lookup.
    """
    parts = _document_url_parts(client_id)
    if parts is None or parts.scheme != _HTTPS:
        return False
    return _host_is_public(parts) and _path_is_plain(parts.path)


def parse_client_metadata_document(body: bytes, client_id: str) -> ClientMetadata | None:
    """Parse a fetched document for ``client_id``, or ``None`` if it is not one.

    The document must be a JSON object whose own ``client_id`` is exactly the
    URL it came from, and must pass :func:`validate_client_metadata`. Any
    failure is the same ``None``: the person is shown that the agent could not
    be identified, never why, because the why is the remote page's content.
    """
    try:
        document = ClientMetadataDocument.model_validate_json(body)
    except ValidationError:
        return None
    if document.client_id != client_id:
        return None
    validated = validate_client_metadata(document)
    return validated if isinstance(validated, ClientMetadata) else None
