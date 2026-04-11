# sec-06: LLM API key accepted as empty string

**Labels:** `security`, `backend`, `priority-medium`
**Severity:** MEDIUM
**OWASP:** A07:2021 — Identification and Authentication Failures
**Estimated LoC:** ~15

## Problem

The BotMason service at `backend/src/services/botmason.py:117-118` and
`135-136` initializes LLM clients with an empty-string default for the API key:

```python
api_key = os.getenv("LLM_API_KEY", "")
client = openai_mod.AsyncOpenAI(api_key=api_key)
```

When the `openai` or `anthropic` provider is selected but `LLM_API_KEY` is
not set, the service will:

1. Create a client with an empty API key
2. Make an API call that fails with an unhelpful authentication error
3. Return a 500 to the user with no clear indication of the misconfiguration

This is in contrast to `SECRET_KEY` handling in `auth.py:43-46` which
correctly fails fast with a descriptive error.

## Tasks

1. **Fail fast when LLM_API_KEY is missing for non-stub providers**
   ```python
   def _get_llm_api_key() -> str:
       api_key = os.getenv("LLM_API_KEY", "")
       if not api_key:
           msg = "LLM_API_KEY must be set when using openai or anthropic provider"
           raise RuntimeError(msg)
       return api_key
   ```

2. **Call `_get_llm_api_key()` in both `_call_openai` and `_call_anthropic`**

3. **Add test**
   - Test that calling `generate_response` with `BOTMASON_PROVIDER=openai`
     and no `LLM_API_KEY` raises RuntimeError

## Acceptance Criteria

- Server raises RuntimeError at call time if LLM_API_KEY is unset for
  non-stub providers
- Error message clearly identifies the missing configuration
- Stub provider continues to work without LLM_API_KEY

## Files to Modify

| File | Action |
|------|--------|
| `backend/src/services/botmason.py` | Add API key validation |
| `backend/tests/test_botmason.py` | Add missing-key test |
