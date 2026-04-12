"""BotMason AI service — LLM integration layer.

Supports configurable LLM providers via environment variables. The service
loads a system prompt from a file path or inline text and maintains
conversation history context for coherent multi-turn chat.
"""

from __future__ import annotations

import importlib
import os
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType

# Default system prompt used when no external prompt file is configured.
_DEFAULT_SYSTEM_PROMPT = (
    "You are BotMason, a Liminal Trickster Mystic guide for the APTITUDE "
    "personal development program. You help users navigate the transition "
    "from 'Liminal Creep' to 'Whole Adept' through the Archetypal Wavelength. "
    "Respond with wisdom, warmth, and a touch of playful mysticism. "
    "Reference the APTITUDE stages, habits, practices, and journaling when relevant."
)

# Maximum number of recent messages to include as conversation context.
CONVERSATION_HISTORY_LIMIT = 20

# Only allow prompt files from this directory to prevent path traversal.
_ALLOWED_PROMPT_DIR = Path(__file__).resolve().parent.parent / "prompts"

# Maximum prompt file size in bytes (50 KB).
_MAX_PROMPT_FILE_SIZE = 50 * 1024

# Maximum allowed length for a user-supplied LLM API key. Real keys from
# OpenAI/Anthropic are ~200 chars; this cap prevents header-size DoS.
LLM_API_KEY_MAX_LENGTH = 256

# Provider-specific key prefixes. Anthropic keys share the ``sk-`` prefix with
# OpenAI, so their check is the more specific ``sk-ant-``.
_OPENAI_KEY_PREFIX = "sk-"
_ANTHROPIC_KEY_PREFIX = "sk-ant-"

# Identifier the stub provider reports as its "model" in usage logs.  Kept as a
# module constant so callers can branch on it without magic strings.
STUB_MODEL_NAME = "stub"


@dataclass(frozen=True, slots=True)
class LLMResponse:
    """Response from an LLM provider plus the token counts needed for metering.

    ``text`` is the bot's reply that becomes a :class:`JournalEntry`; every
    other field is metadata for the usage log.  The stub provider reports
    zero tokens and the sentinel model :data:`STUB_MODEL_NAME` so downstream
    accounting can treat it as a free no-op.
    """

    text: str
    provider: str
    model: str
    prompt_tokens: int
    completion_tokens: int

    @property
    def total_tokens(self) -> int:
        """Sum of prompt and completion tokens — always derived, never stored."""
        return self.prompt_tokens + self.completion_tokens


def get_provider() -> str:
    """Return the currently configured LLM provider identifier."""
    return os.getenv("BOTMASON_PROVIDER", "stub")


def provider_requires_api_key(provider: str | None = None) -> bool:
    """Return True when the selected provider needs an API key to function."""
    return (provider or get_provider()) in {"openai", "anthropic"}


# Prefix rules per provider — a dict keeps ``validate_llm_api_key_format``
# branch-free so xenon's complexity budget stays at rank A.
_PROVIDER_KEY_RULES: dict[str, tuple[str, tuple[str, ...]]] = {
    # provider -> (required_prefix, disallowed_more_specific_prefixes)
    # OpenAI keys start with ``sk-``; Anthropic keys also do, so disallow the
    # more specific ``sk-ant-`` prefix to prevent provider cross-wiring.
    "openai": (_OPENAI_KEY_PREFIX, (_ANTHROPIC_KEY_PREFIX,)),
    "anthropic": (_ANTHROPIC_KEY_PREFIX, ()),
}


def _has_valid_length(api_key: str) -> bool:
    """Return True when the key is non-empty and within the header-size cap."""
    return bool(api_key) and len(api_key) <= LLM_API_KEY_MAX_LENGTH


def _matches_provider_rule(api_key: str, rule: tuple[str, tuple[str, ...]] | None) -> bool:
    """Return True when the key satisfies a (prefix, disallowed-prefixes) rule.

    ``rule`` is ``None`` for unknown or stub providers, which are considered
    passing — the real provider call happens later.
    """
    if rule is None:
        return True
    required_prefix, disallowed_prefixes = rule
    if not api_key.startswith(required_prefix):
        return False
    return not any(api_key.startswith(bad) for bad in disallowed_prefixes)


def validate_llm_api_key_format(api_key: str, provider: str) -> bool:
    """Return True when ``api_key`` matches the expected format for ``provider``.

    The check is intentionally prefix-based — real key validation happens when
    the provider rejects the request. The purpose here is to stop obviously
    malformed values from leaving our server (and to keep Anthropic keys from
    being routed through the OpenAI client by mistake). Unknown providers
    (including ``"stub"``) skip the check entirely.
    """
    if not _has_valid_length(api_key):
        return False
    return _matches_provider_rule(api_key, _PROVIDER_KEY_RULES.get(provider))


def get_system_prompt() -> str:
    """Load the BotMason system prompt from config.

    Checks ``BOTMASON_SYSTEM_PROMPT`` env var first. If it points to a file
    that exists **within the allowed prompts directory**, the file contents
    are returned. Otherwise the env var value is used as inline text. Falls
    back to the built-in default prompt.

    Raises:
        RuntimeError: If the file path resolves outside the allowed directory
            or exceeds the maximum file size.
    """
    prompt_config = os.getenv("BOTMASON_SYSTEM_PROMPT", "")
    if not prompt_config:
        return _DEFAULT_SYSTEM_PROMPT

    prompt_path = Path(prompt_config).resolve()
    if prompt_path.is_file():
        # Prevent path traversal — must be within the allowed directory
        try:
            prompt_path.relative_to(_ALLOWED_PROMPT_DIR.resolve())
        except ValueError:
            msg = f"BOTMASON_SYSTEM_PROMPT path must be within {_ALLOWED_PROMPT_DIR}"
            raise RuntimeError(msg) from None

        file_size = prompt_path.stat().st_size
        if file_size > _MAX_PROMPT_FILE_SIZE:
            msg = (
                f"BOTMASON_SYSTEM_PROMPT file exceeds maximum size "
                f"({file_size} > {_MAX_PROMPT_FILE_SIZE} bytes)"
            )
            raise RuntimeError(msg)

        return prompt_path.read_text().strip()

    # Treat as inline text
    return prompt_config


def _build_messages(
    user_message: str,
    conversation_history: list[dict[str, str]],
    system_prompt: str,
) -> list[dict[str, str]]:
    """Build the message list for the LLM API call.

    Returns a list of dicts with ``role`` and ``content`` keys suitable for
    OpenAI-compatible chat completion APIs.
    """
    messages: list[dict[str, str]] = [{"role": "system", "content": system_prompt}]
    for entry in conversation_history:
        role = "assistant" if entry.get("sender") == "bot" else "user"
        messages.append({"role": role, "content": entry["message"]})
    messages.append({"role": "user", "content": user_message})
    return messages


async def generate_response(
    user_message: str,
    conversation_history: list[dict[str, str]],
    system_prompt: str | None = None,
    api_key: str | None = None,
) -> LLMResponse:
    """Generate a BotMason response using the configured LLM provider.

    Currently supports the ``BOTMASON_PROVIDER`` env var with values:

    - ``"stub"`` (default) — returns a canned response for development/testing
    - ``"openai"`` — calls the OpenAI chat completions API
    - ``"anthropic"`` — calls the Anthropic messages API

    External providers require an API key. Callers may pass ``api_key``
    directly (e.g. sourced from a user-supplied header) to override the
    server-side ``LLM_API_KEY`` env var. When ``api_key`` is ``None`` the
    env var is used; the key is never persisted or logged by this layer.

    Returns an :class:`LLMResponse` carrying both the generated text and the
    token counts needed to log usage downstream.
    """
    resolved_prompt = system_prompt or get_system_prompt()
    provider = get_provider()

    if provider == "openai":
        return await _call_openai(user_message, conversation_history, resolved_prompt, api_key)
    if provider == "anthropic":
        return await _call_anthropic(user_message, conversation_history, resolved_prompt, api_key)
    # Default: stub provider for development and testing
    return _stub_response(user_message)


def _stub_response(user_message: str) -> LLMResponse:
    """Return a deterministic response for development and testing.

    Token counts are zero because no real model is invoked — this keeps the
    usage log's cost total honest when stub traffic is mixed with production
    calls during load tests.
    """
    text = (
        f'BotMason hears you. You said: "{user_message}" — '
        "Let the Archetypal Wavelength guide your reflection."
    )
    return LLMResponse(
        text=text,
        provider="stub",
        model=STUB_MODEL_NAME,
        prompt_tokens=0,
        completion_tokens=0,
    )


def _import_optional(module_name: str, provider_label: str) -> ModuleType:
    """Import an optional SDK, raising a clear error if not installed."""
    try:
        return importlib.import_module(module_name)
    except ImportError as exc:
        msg = (
            f"{module_name} package is required for the {provider_label} provider. "
            f"Install it with: pip install {module_name}"
        )
        raise RuntimeError(msg) from exc


def _get_llm_api_key() -> str:
    """Return the server-side LLM API key, raising if unset or empty.

    Follows the same fail-fast pattern as ``_get_secret_key`` in auth.py.
    """
    api_key = os.getenv("LLM_API_KEY", "")
    if not api_key:
        msg = "LLM_API_KEY environment variable must be set for non-stub providers"
        raise RuntimeError(msg)
    return api_key


def _resolve_api_key(override: str | None) -> str:
    """Return the API key to use for a provider call.

    Prefers the caller-supplied ``override`` (e.g. user-owned BYOK key from a
    request header) and falls back to the server-side ``LLM_API_KEY`` env var.
    The key is returned by value — callers must not log or persist it.
    """
    if override:
        return override
    return _get_llm_api_key()


def extract_token_count(source: object, *attrs: str) -> int:
    """Return the first non-``None`` attribute value coerced to a non-negative int.

    Providers occasionally drop ``usage`` from streaming or error responses.
    Treating a missing value as zero keeps the usage log append even when
    upstream returns incomplete metadata — accepting "unknown" costs less
    than losing the whole observability trail.
    """
    if source is None:
        return 0
    for attr in attrs:
        value = getattr(source, attr, None)
        if value is not None:
            try:
                return max(int(value), 0)
            except (TypeError, ValueError):
                continue
    return 0


async def _call_openai(
    user_message: str,
    conversation_history: list[dict[str, str]],
    system_prompt: str,
    api_key: str | None = None,
) -> LLMResponse:
    """Call the OpenAI chat completions API."""
    key = _resolve_api_key(api_key)
    openai_mod = _import_optional("openai", "OpenAI")

    client = openai_mod.AsyncOpenAI(api_key=key)
    messages = _build_messages(user_message, conversation_history, system_prompt)
    model = os.getenv("LLM_MODEL", "gpt-4o-mini")
    completion = await client.chat.completions.create(
        model=model,
        messages=messages,
    )
    usage = getattr(completion, "usage", None)
    return LLMResponse(
        text=str(completion.choices[0].message.content or ""),
        provider="openai",
        model=model,
        prompt_tokens=extract_token_count(usage, "prompt_tokens"),
        completion_tokens=extract_token_count(usage, "completion_tokens"),
    )


async def _call_anthropic(
    user_message: str,
    conversation_history: list[dict[str, str]],
    system_prompt: str,
    api_key: str | None = None,
) -> LLMResponse:
    """Call the Anthropic messages API."""
    key = _resolve_api_key(api_key)
    anthropic_mod = _import_optional("anthropic", "Anthropic")

    client = anthropic_mod.AsyncAnthropic(api_key=key)
    # Anthropic uses a separate system parameter, not a system message in the list.
    messages_for_api: list[dict[str, str]] = []
    for entry in conversation_history:
        role = "assistant" if entry.get("sender") == "bot" else "user"
        messages_for_api.append({"role": role, "content": entry["message"]})
    messages_for_api.append({"role": "user", "content": user_message})

    model = os.getenv("LLM_MODEL", "claude-sonnet-4-20250514")
    response = await client.messages.create(
        model=model,
        max_tokens=1024,
        system=system_prompt,
        messages=messages_for_api,
    )
    block = response.content[0]
    text = str(block.text) if hasattr(block, "text") else str(block)
    usage = getattr(response, "usage", None)
    return LLMResponse(
        text=text,
        provider="anthropic",
        model=model,
        # Anthropic exposes ``input_tokens`` / ``output_tokens`` where OpenAI
        # uses ``prompt_tokens`` / ``completion_tokens``.
        prompt_tokens=extract_token_count(usage, "input_tokens", "prompt_tokens"),
        completion_tokens=extract_token_count(usage, "output_tokens", "completion_tokens"),
    )
