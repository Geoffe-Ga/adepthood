"""Send one marked prompt past the stub to a real provider, when configured to.

A deployment whose ``BOTMASON_PROVIDER`` is the default ``stub`` answers every
prompt itself: no key, no network, no third party. That determinism is the
reason the stub exists, and it is also the reason everything behind it goes
unexercised. Key resolution, the SDK's request building, the transport, this
layer's retry budget, and the classification of whatever the provider answers
are all live code on such a deployment and none of it ever runs.

``BOTMASON_PROVIDER_PROBE_TOKEN`` names a secret that closes that gap for one
request at a time. A prompt carrying ``<token>:<provider>`` is dialled to that
provider with the server's configured key instead of being answered by the stub;
every other prompt is untouched. What comes back is therefore the provider's own
answer, and a refusal is an exception the SDK built out of the provider's real
response body rather than one this codebase raised on its behalf — the exact
difference between proving a classification and assuming it (#2479, #2543).

Four things keep it from being a hole:

* It is **off unless configured**. With the variable unset — every ordinary
  deployment, every developer laptop, the whole backend suite — this module
  answers ``None`` before it looks at the message at all.
* The token has a **length floor**. An empty or truncated value cannot arm the
  seam, so a marker is never something a writer can stumble into and never
  something every prompt satisfies.
* It is only consulted when **no real provider is configured**
  (:func:`services.botmason._provider_for_request`), so a deployment that
  already dials OpenAI or Anthropic cannot have a request redirected by text in
  an entry. The probe cannot weaken the path it exists to exercise.
* :func:`main.validate_provider_probe_config` **refuses a production boot**
  while it is armed, on the same terms as the capture email backend: a seam that
  routes user text to a provider chosen by that text does not belong in front of
  real users, and "discouraged" is not a control.

The end-to-end lane is the caller this was built for. It boots the real server
with the stub as its provider, arms this token with a per-run random value, and
points ``OPENAI_BASE_URL`` / ``ANTHROPIC_BASE_URL`` at a loopback fake that
refuses for billing — which is how a journey about a spent balance can be driven
against a server that has no provider account at all.
"""

from __future__ import annotations

import os
from collections.abc import Iterable

#: Environment variable naming this deployment's probe token. Unset everywhere
#: by default; the lane writes a per-run random value into it. Named for the
#: variable rather than for the secret in it, as the other ``*_ENV_VAR``
#: constants in this codebase are.
PROVIDER_PROBE_ENV_VAR = "BOTMASON_PROVIDER_PROBE_TOKEN"  # pragma: allowlist secret

#: Shortest value that can arm the probe. Long enough that a marker is not
#: something a writer could type by accident and not something an operator
#: could arm with a placeholder; short enough that a UUID or 16 random bytes of
#: base64 clears it comfortably.
MIN_PROBE_TOKEN_LENGTH = 16

#: What separates the token from the provider it names. Both halves are
#: required: a bare token selects nothing, so a value that leaked into a log
#: cannot be pasted somewhere and quietly become a dial.
PROBE_SEPARATOR = ":"


def armed_probe_token() -> str | None:
    """Return this deployment's probe token, or ``None`` when it is not armed.

    Trimmed, because a value pasted into a dashboard or read out of a file
    routinely arrives with a trailing newline, and a token that silently differs
    from the one the operator set is indistinguishable from a broken seam. The
    length floor is applied after trimming for the same reason: whitespace must
    not be able to pad a short value past the check.
    """
    token = os.getenv(PROVIDER_PROBE_ENV_VAR, "").strip()
    if len(token) < MIN_PROBE_TOKEN_LENGTH:
        return None
    return token


def probed_provider(user_message: str, known_providers: Iterable[str]) -> str | None:
    """Return the provider ``user_message`` is marked for, or ``None``.

    ``known_providers`` is the caller's own registry of real providers, passed
    in rather than imported so this module stays free of
    :mod:`services.botmason` (which imports the stub, which imports the
    resonance domain). Matching against it — rather than trusting the name in
    the marker — means a marked prompt can only ever select a provider this
    server already knows how to dial.
    """
    token = armed_probe_token()
    if token is None:
        return None
    return next(
        (
            provider
            for provider in known_providers
            if f"{token}{PROBE_SEPARATOR}{provider}" in user_message
        ),
        None,
    )
