"""A credential held in a dataclass must not ride that dataclass's repr anywhere.

A generated ``__repr__`` renders every field verbatim, and nothing about holding a
secret in one changes that. So the moment a credential becomes a dataclass field
it acquires three exits nobody wrote: a log line that interpolates the object, a
traceback frame that renders the locals around the raise, and a debugger session
that prints the value on sight. None of those are calls the author of the
credential-handling code makes -- they are calls made by machinery downstream of
it, which is exactly why reviewing the code that touches the field cannot find
them.

The remedy is per-field and one word long: ``field(repr=False)`` on the credential
alone, so the surrounding object keeps a useful repr. Suppressing the whole repr
would trade one debugging problem for another and, being the coarser fix, is the
one more likely to be quietly undone later.

These cases pin the invariant per credential-bearing dataclass. Each builds the
object with an inert sentinel and asserts the sentinel does not appear in the
rendered repr -- which is the property that matters, and stays true however the
suppression is spelled.
"""

from __future__ import annotations

from routers.journal import _ReflectionClients
from services.creek_vault_client import LocalFallbackCreekVaultClient

# Obviously inert, and distinctive enough that a substring match cannot pass by
# coincidence with anything else the repr renders.
_BYOK_KEY_SENTINEL = "byok-secret-do-not-log-9f31ac"  # pragma: allowlist secret


def test_reflection_clients_repr_hides_the_caller_supplied_llm_key() -> None:
    """The BYOK key arriving in ``X-LLM-API-Key`` stays out of the bundle's repr.

    The second assertion is the half that keeps the first honest: suppressing
    the whole repr would also hide the sentinel, and would cost the debugging
    value the object exists to give.
    """
    clients = _ReflectionClients(
        api_key=_BYOK_KEY_SENTINEL,
        vault_client=LocalFallbackCreekVaultClient(),
    )

    rendered = repr(clients)

    assert _BYOK_KEY_SENTINEL not in rendered
    assert LocalFallbackCreekVaultClient.__name__ in rendered
