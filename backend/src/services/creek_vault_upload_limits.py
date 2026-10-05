"""Validate managed upload envelopes before any document bytes are sent."""

# Fly replay bounds the entire JSON body, including base64 and metadata.
MANAGED_UPLOAD_BODY_BYTES = 1024 * 1024


class ManagedUploadTooLargeError(ValueError):
    """Local request validation, separate from a failed remote vault call."""

    def __init__(self) -> None:
        """Keep document content and filenames out of the refusal."""
        super().__init__("managed_document_too_large")


def guard_managed_upload_body(encoded: bytes) -> None:
    """Bound the complete body encoded by the existing HTTP transport owner."""
    if len(encoded) > MANAGED_UPLOAD_BODY_BYTES:
        raise ManagedUploadTooLargeError
