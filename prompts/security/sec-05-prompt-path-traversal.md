# sec-05: BotMason system prompt loading allows path traversal

**Labels:** `security`, `backend`, `priority-high`
**Severity:** HIGH
**OWASP:** A01:2021 — Broken Access Control (Path Traversal)
**Estimated LoC:** ~25

## Problem

The `get_system_prompt()` function at `backend/src/services/botmason.py:28-41`
reads an arbitrary file path from the `BOTMASON_SYSTEM_PROMPT` environment
variable without any validation:

```python
def get_system_prompt() -> str:
    prompt_config = os.getenv("BOTMASON_SYSTEM_PROMPT", "")
    if prompt_config:
        prompt_path = Path(prompt_config)
        if prompt_path.is_file():
            return prompt_path.read_text().strip()  # reads ANY file on disk
        return prompt_config
    return _DEFAULT_SYSTEM_PROMPT
```

If an attacker gains partial control of environment variables (e.g., through a
misconfigured deployment platform, a `.env` injection, or a future admin
endpoint that sets config), they can read arbitrary files:

```
BOTMASON_SYSTEM_PROMPT=/etc/passwd
BOTMASON_SYSTEM_PROMPT=/app/.env
BOTMASON_SYSTEM_PROMPT=/proc/self/environ
```

The file contents are then loaded as the system prompt and potentially echoed
back through BotMason's AI responses, leaking sensitive data.

**Current risk level:** The env var is only set at deployment time, so
exploitation requires access to the deployment configuration. However, the
pattern is unsafe and should be fixed defensively.

## Tasks

1. **Restrict file reads to an allowed directory**
   ```python
   _ALLOWED_PROMPT_DIR = Path(__file__).resolve().parent.parent / "prompts"

   def get_system_prompt() -> str:
       prompt_config = os.getenv("BOTMASON_SYSTEM_PROMPT", "")
       if not prompt_config:
           return _DEFAULT_SYSTEM_PROMPT

       prompt_path = Path(prompt_config).resolve()
       if prompt_path.is_file():
           # Prevent path traversal — must be within the allowed directory
           try:
               prompt_path.relative_to(_ALLOWED_PROMPT_DIR.resolve())
           except ValueError:
               raise RuntimeError(
                   f"BOTMASON_SYSTEM_PROMPT path must be within {_ALLOWED_PROMPT_DIR}"
               )
           return prompt_path.read_text().strip()

       # Treat as inline text
       return prompt_config
   ```

2. **Add max file size check**
   - Limit prompt files to 50KB to prevent memory exhaustion

3. **Add tests**
   - Test that paths outside the allowed directory are rejected
   - Test that `../../etc/passwd` style paths are rejected
   - Test that valid prompt files within the directory are loaded

## Acceptance Criteria

- System prompt file reads are restricted to an allowed directory
- Path traversal attempts raise RuntimeError at startup
- File size is bounded
- Tests cover traversal attempts

## Files to Modify

| File | Action |
|------|--------|
| `backend/src/services/botmason.py` | Add path validation to get_system_prompt |
| `backend/tests/test_botmason.py` | Add path traversal tests |
