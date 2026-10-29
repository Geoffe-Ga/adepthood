"""Validate managed upload envelopes before any document bytes are sent (#3051).

A managed vault is reached through a replay that bounds the *whole* request
body -- base64 content, filename, metadata and JSON punctuation together -- at
:data:`MANAGED_UPLOAD_BODY_BYTES`. A document under the application's 10 MiB
cap can exceed it once encoded, and resending that unchanged request can never
succeed, so it is refused here, locally, before the transport is touched.

The body is measured exactly as the HTTP transport serializes it: httpx encodes
``json=`` as compact UTF-8 with non-ASCII left unescaped, and
:func:`encoded_upload_body` reproduces those settings. A regression test pins
the two byte-for-byte, so a transport upgrade that changed its encoding fails
loudly rather than letting this bound drift from the wire.

**The operator's vault-send suspension outranks this bound** (#3618). Both stop
the document before the wire, so the choice is only which reason the caller
hears, and the suspension is the true one: nothing is being sent from this
deployment at all, and "shrink the document" would be advice no action of the
user's can follow. While ``PRIVACY_SUSPEND_VAULT_SEND`` is on the bound is
therefore not measured, and the adapter's single request site refuses the call
as suspended -- the one place that refusal is raised, so it is not restated
here.
"""

from __future__ import annotations

import json
from collections.abc import Mapping

from services.privacy_suspension import vault_send_suspended

# Fly replay bounds the entire JSON body, including base64 and metadata.
MANAGED_UPLOAD_BODY_BYTES = 1024 * 1024


class ManagedUploadTooLargeError(ValueError):
    """Local request validation, separate from a failed remote vault call."""

    def __init__(self) -> None:
        """Keep document content and filenames out of the refusal."""
        super().__init__("managed_document_too_large")


def encoded_upload_body(body: Mapping[str, object]) -> bytes:
    """Serialize ``body`` with the HTTP transport's own ``json=`` settings."""
    return json.dumps(body, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode(
        "utf-8"
    )


def guard_managed_upload_body(body: Mapping[str, object], *, managed: bool) -> None:
    """Refuse a managed upload whose encoded request exceeds the replay ceiling.

    A self-hosted vault (``managed`` false) is not reached through the replay,
    so its uploads keep the application's own cap and are never measured here.
    Nor is any body while vault sends are suspended: that refusal outranks this
    one, and the request site raises it next (see the module docstring).
    """
    if not managed or vault_send_suspended():
        return
    if len(encoded_upload_body(body)) > MANAGED_UPLOAD_BODY_BYTES:
        raise ManagedUploadTooLargeError
