# audit-testq-03: Cover the BotMason streaming paths

**Labels:** `audit-testq`, `backend`, `testing`, `priority-high`
**Epic:** Test Quality & Green Baseline
**Estimated LoC:** ~280  (hard cap 700)

## Problem

The two real production LLM streaming functions —
`_stream_openai` (`backend/src/services/botmason.py:867`) and
`_stream_anthropic` (`backend/src/services/botmason.py:916`) — carry
`# pragma: no cover - exercised via live integration`, as do their helpers
`_first_choice_delta_content` (`:847`) and `_extract_openai_delta_text` (`:859`).
**Current state:** §5.4 "hollow coverage" (`2026-06-24_ADEPTHOOD_FULL_AUDIT.md:148`)
— these are the paths that actually serve BotMason chat for BYOK users, yet they
are excluded from coverage and ship untested. A regression in delta extraction,
token accumulation, usage parsing, or the terminal `LLMResponse` yield would not
be caught by any test. Only the deterministic stub path (`_stream_stub`, `:829`)
is exercised.

## Scope

**Covers:** unit tests for `_stream_openai`, `_stream_anthropic`, and their delta
helpers using a **mocked SDK/transport** (no live key, no network) so the
streaming logic — chunk yielding, text accumulation, `include_usage` handling,
token-count extraction via `extract_token_count`, and the final `LLMResponse`
payload (provider, model, prompt/completion tokens) — is asserted; then removing
the `# pragma: no cover` markers from all four symbols.

**Does NOT cover:** real network calls or contract tests against live OpenAI /
Anthropic endpoints; changing the streaming implementation; the stub path (already
covered); router-level SSE wiring (covered elsewhere).

## Tasks

1. **Mock the OpenAI async client** — patch `_import_optional("openai", ...)`
   (or `openai_mod.AsyncOpenAI`) so `client.chat.completions.create(...)` returns
   an async iterator of fake event objects with `.choices[0].delta.content` and a
   final `.usage` carrying `prompt_tokens`/`completion_tokens`. Assert the
   function yields each delta chunk in order, accumulates them, and the terminal
   yield is `("", LLMResponse(text=<joined>, provider="openai", model=..., ...))`
   with the exact token counts. Include an event with `delta.content=None` to
   exercise the `_extract_openai_delta_text` skip branch.
2. **Mock the Anthropic async client** — patch `_import_optional("anthropic", ...)`
   so `client.messages.stream(...)` is an async context manager exposing
   `text_stream` (async iterator of strings) and `get_final_message()` returning
   an object with `.usage.input_tokens`/`.output_tokens`. Assert chunk order,
   accumulation, the empty-string filter (`if text:`), and the final
   `LLMResponse(provider="anthropic", ...)` token mapping.
3. **Cover the delta helpers directly** — `_first_choice_delta_content` and
   `_extract_openai_delta_text` with empty choices, missing `delta`, non-string
   content, and a valid string, asserting exact returns.
4. **Remove the pragmas** — delete `# pragma: no cover` from
   `botmason.py:847,859,867,916` and confirm the lines are now counted and
   covered. TDD: write each test red against the un-pragma'd line first.

## Acceptance Criteria

- [ ] `_stream_openai`, `_stream_anthropic`, `_first_choice_delta_content`, and
      `_extract_openai_delta_text` are covered by tests that run with **no live
      API key and no network** (mocked SDK/transport), proven by `pytest`
      passing offline.
- [ ] All four `# pragma: no cover` markers are removed and the lines show as
      covered in `--cov-report=term-missing`.
- [ ] Tests assert exact streamed chunks, accumulated text, and the terminal
      `LLMResponse` fields (provider, model, prompt_tokens, completion_tokens) —
      not just "it returned something" — mutation-grade against token-mapping or
      accumulation bugs.
- [ ] No existing tests break; backend line coverage ≥ 90%, branch ≥ 80%.
- [ ] All pre-commit hooks pass on `--all-files`.

## Files to Create/Modify

| File | Action |
|---|---|
| `backend/src/services/botmason.py` | Modify — remove the four `# pragma: no cover` markers |
| `backend/tests/services/test_botmason_streaming.py` | Create — mocked-SDK tests for the OpenAI/Anthropic streaming paths and delta helpers |
