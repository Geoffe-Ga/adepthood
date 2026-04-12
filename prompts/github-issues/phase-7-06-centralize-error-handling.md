# Phase 6-06: Centralize Error Handling

## Problem

Error handling is inconsistent across the stack:

### Backend
- `errors.py` provides `not_found()`, `bad_request()` helpers — good, but not all routers use them
- `main.py:186` catches Exception generically for health check
- `services/botmason.py` has zero try/except on LLM calls — raw exceptions propagate
- Different routers signal errors differently: `HTTPException`, `errors.*`, raw raise

### Frontend
- `HabitsScreen` shows error banner with retry button
- `CourseScreen` catches errors, logs to console, silently fails
- `PracticeScreen` sets error state but never displays it
- No error boundaries around modals — a thrown error blanks the entire screen

## Fix

### Backend: Global Exception Handler

```python
# main.py
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.exception("unhandled_error", extra={"path": request.url.path})
    return JSONResponse(status_code=500, content={"detail": "internal_error"})
```

All routers should use `errors.py` helpers exclusively. No direct `HTTPException` construction.

### Frontend: Shared Error Display Pattern

```typescript
// components/DataErrorBanner.tsx
export const DataErrorBanner = ({ error, onRetry }: Props) => (
  <View style={styles.banner}>
    <Text>{error}</Text>
    {onRetry && <TouchableOpacity onPress={onRetry}><Text>Retry</Text></TouchableOpacity>}
  </View>
);
```

Every feature screen uses this component. No more silent failures.

### Frontend: Error Boundaries on Modals

Wrap each modal in `<ErrorBoundary>` so a crash in GoalModal doesn't blank HabitsScreen.

## Acceptance Criteria

- [ ] Backend: all routers use `errors.py` helpers (no direct HTTPException)
- [ ] Backend: global exception handler logs and returns generic error
- [ ] Backend: LLM provider errors caught and mapped to user-friendly responses
- [ ] Frontend: every feature screen displays errors with retry option
- [ ] Frontend: every modal wrapped in ErrorBoundary
- [ ] All existing tests pass

## Estimated Scope
~200 LoC
