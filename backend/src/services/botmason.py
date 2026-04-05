"""BotMason AI service — LLM integration layer.

Supports configurable LLM providers via environment variables. The service
loads a system prompt from a file path or inline text and maintains
conversation history context for coherent multi-turn chat.
"""

from __future__ import annotations

import importlib
import os
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


def get_system_prompt() -> str:
    """Load the BotMason system prompt from config.

    Checks ``BOTMASON_SYSTEM_PROMPT`` env var first. If it points to a file
    that exists, the file contents are returned. Otherwise the env var value
    is used as inline text. Falls back to the built-in default prompt.
    """
    prompt_config = os.getenv("BOTMASON_SYSTEM_PROMPT", "")
    if prompt_config:
        prompt_path = Path(prompt_config)
        if prompt_path.is_file():
            return prompt_path.read_text().strip()
        return prompt_config
    return _DEFAULT_SYSTEM_PROMPT


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
) -> str:
    """Generate a BotMason response using the configured LLM provider.

    Currently supports the ``BOTMASON_PROVIDER`` env var with values:

    - ``"stub"`` (default) — returns a canned response for development/testing
    - ``"openai"`` — calls the OpenAI chat completions API
    - ``"anthropic"`` — calls the Anthropic messages API

    External providers require the ``LLM_API_KEY`` env var to be set and
    the corresponding SDK to be installed.
    """
    resolved_prompt = system_prompt or get_system_prompt()
    provider = os.getenv("BOTMASON_PROVIDER", "stub")

    if provider == "openai":
        return await _call_openai(user_message, conversation_history, resolved_prompt)
    if provider == "anthropic":
        return await _call_anthropic(user_message, conversation_history, resolved_prompt)
    # Default: stub provider for development and testing
    return _stub_response(user_message)


def _stub_response(user_message: str) -> str:
    """Return a deterministic response for development and testing."""
    return (
        f'BotMason hears you. You said: "{user_message}" — '
        "Let the Archetypal Wavelength guide your reflection."
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


async def _call_openai(
    user_message: str,
    conversation_history: list[dict[str, str]],
    system_prompt: str,
) -> str:
    """Call the OpenAI chat completions API."""
    openai_mod = _import_optional("openai", "OpenAI")

    api_key = os.getenv("LLM_API_KEY", "")
    client = openai_mod.AsyncOpenAI(api_key=api_key)
    messages = _build_messages(user_message, conversation_history, system_prompt)
    completion = await client.chat.completions.create(
        model=os.getenv("LLM_MODEL", "gpt-4o-mini"),
        messages=messages,
    )
    return str(completion.choices[0].message.content or "")


async def _call_anthropic(
    user_message: str,
    conversation_history: list[dict[str, str]],
    system_prompt: str,
) -> str:
    """Call the Anthropic messages API."""
    anthropic_mod = _import_optional("anthropic", "Anthropic")

    api_key = os.getenv("LLM_API_KEY", "")
    client = anthropic_mod.AsyncAnthropic(api_key=api_key)
    # Anthropic uses a separate system parameter, not a system message in the list.
    messages_for_api: list[dict[str, str]] = []
    for entry in conversation_history:
        role = "assistant" if entry.get("sender") == "bot" else "user"
        messages_for_api.append({"role": role, "content": entry["message"]})
    messages_for_api.append({"role": "user", "content": user_message})

    response = await client.messages.create(
        model=os.getenv("LLM_MODEL", "claude-sonnet-4-20250514"),
        max_tokens=1024,
        system=system_prompt,
        messages=messages_for_api,
    )
    block = response.content[0]
    return str(block.text) if hasattr(block, "text") else str(block)
