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

The token endpoint (#3533) answers with :class:`TokenResponse` and publishes its
verification keys as :class:`JsonWebKeySet`, which by construction has no field
for a private key.

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


class AuthorizationQuery(BaseModel):
    """The RFC 6749 / RFC 7636 / RFC 8707 query of ``GET /oauth/authorize``.

    Every field optional at the schema level: a missing one is a protocol fault
    the endpoint answers with an RFC error -- on a page, or back at the agent --
    never with a validation 422 the person's browser would show as raw JSON.
    """

    response_type: str | None = None
    client_id: str | None = None
    redirect_uri: str | None = None
    code_challenge: str | None = None
    code_challenge_method: str | None = None
    state: str | None = None
    scope: str | None = None
    resource: str | None = None


class TokenResponse(BaseModel):
    """A successful token response, RFC 6749 section 5.1, with the scope always stated."""

    access_token: str
    token_type: str
    expires_in: int
    refresh_token: str | None = None
    scope: str


class PublicJsonWebKey(BaseModel):
    """One P-256 public key as RFC 7517 / RFC 7518 section 6.2.1 publish it. No private part."""

    kty: str
    crv: str
    x: str
    y: str
    kid: str
    alg: str
    use: str


class JsonWebKeySet(BaseModel):
    """The key set the vault verifies agent tokens with, newest key first."""

    keys: list[PublicJsonWebKey]
