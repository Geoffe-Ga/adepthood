# phase-8-07: Unit-test BotMason streaming with fake SDK streams

**Labels:** `phase-8`, `backend`, `tests`, `priority-medium`
**Epic:** Phase 8 — Post-Drain Hardening
**Depends on:** None
**Estimated LoC:** ~225 (tests + pragma removal)

## Problem

`backend/src/services/botmason.py`'s streaming entrypoints —
`_stream_openai` and `_stream_anthropic` — are both marked
`# pragma: no cover - exercised via live integration`, which means the
SSE path that production chat actually uses has **zero automated
coverage**. `services/botmason.py` sits at ~85% line coverage, the lowest
of the actively-developed backend modules, almost entirely because of
these two functions. Issue #402 proved the non-streaming path with fake
SDK clients monkeypatched onto the real import path
(`test_botmason_api.py::_FakeOpenAIClient` / `_FakeAnthropicClient`);
the same technique extends naturally to streams.

## Scope

Test-only plus pragma removal — no production code changes unless a test
exposes a real defect (fix it in the same PR, test-first).

## Tasks

1. **Fake streaming clients** (in `backend/tests/test_botmason_api.py` or a
   new `test_botmason_streaming.py`)
   - OpenAI: an async-iterator of chat-completion chunks (delta content,
     terminal usage chunk), shaped like `AsyncOpenAI`'s
     `chat.completions.create(stream=True)` result.
   - Anthropic: an async context/stream yielding `content_block_delta`
     events plus a final message with `usage`, matching what
     `_stream_anthropic` consumes.

2. **Behavioral tests through `generate_response_stream`**
   - Chunks arrive in order with `final=None`; the terminal yield carries
     an `LLMResponse` whose text equals the concatenated chunks and whose
     token counts come from the stream's usage payload.
   - Provider routing: registry `stream_name` resolution covers both
     providers (and the stub path yields a single final).
   - A mid-stream provider exception surfaces as the documented error
     (not a hang or silent truncation).

3. **Remove the pragmas**
   - Delete both `# pragma: no cover` markers; the module's coverage gate
     must hold without them.

## Acceptance Criteria

- `_stream_openai` / `_stream_anthropic` have no coverage pragmas and are
  exercised by deterministic unit tests (no network).
- `services/botmason.py` line coverage ≥ 92%.
- Full backend suite green; coverage/docstring thresholds unchanged.
- No existing tests break.

## Files to Create/Modify

| File | Action |
|------|--------|
| `backend/tests/test_botmason_streaming.py` | **Create** |
| `backend/src/services/botmason.py` | Modify (pragma removal only) |
