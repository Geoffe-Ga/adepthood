"""Wire shapes for the vault-agent authorization server (#3532).

Two bodies arrive as JSON: a dynamic registration request (RFC 7591) and, by
fetch rather than by POST, a client metadata document. They carry the same
fields, so one schema reads both and :mod:`services.oauth_client_metadata`
judges both with one set of rules.

The schema only checks *types*. Whether a redirect is registrable or a name is
readable is decided by the service, which answers with RFC 7591's own error
codes; a Pydantic refusal here is reserved for a body that is not the right
shape at all. Unknown fields are ignored rather than refused, as RFC 7591
section 2 asks: clients send fields this server has no use for (``scope``,
``contacts``, ``software_id``) and a registration must not fail over them.

The registration response has no secret field, because a public client has no
secret. That is a property of the type rather than of a handler remembering.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class ClientRegistrationRequest(BaseModel):
    """What an agent says about itself: RFC 7591 client metadata, the fields read here."""

    model_config = ConfigDict(extra="ignore")

    redirect_uris: list[str]
    client_name: str | None = None
    logo_uri: str | None = None
    grant_types: list[str] | None = None
    response_types: list[str] | None = None
    token_endpoint_auth_method: str | None = None


class ClientMetadataDocument(ClientRegistrationRequest):
    """A fetched client metadata document: the same fields, plus the ``client_id`` it claims."""

    client_id: str


class ClientRegistrationResponse(BaseModel):
    """The registered client, as RFC 7591 section 3.2.1 returns it. No secret."""

    client_id: str
    client_id_issued_at: int
    client_name: str
    redirect_uris: list[str]
    logo_uri: str | None
    grant_types: list[str]
    response_types: list[str]
    token_endpoint_auth_method: str


class OAuthErrorResponse(BaseModel):
    """An RFC 6749 / RFC 7591 error body: a code a client switches on, and a sentence."""

    error: str
    error_description: str | None = None
