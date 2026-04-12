---
name: testing
description: >-
  Write comprehensive, maintainable tests following TDD and AAA pattern.
  Use when writing unit tests, integration tests, setting up fixtures,
  mocking dependencies, or improving test coverage. Covers Python (pytest)
  and TypeScript (Jest/React Native Testing Library).
metadata:
  author: Geoff
  version: 1.0.0
---

# Testing

Test behavior, not implementation. One assertion concept per test. Follow AAA (Arrange-Act-Assert).

## Instructions

### Principles

1. Test behavior, not implementation
2. One assertion concept per test
3. Follow AAA pattern (Arrange-Act-Assert)
4. Write tests first (TDD) when possible
5. Keep tests fast and isolated
6. Make tests readable and self-documenting

### Backend (pytest + async)

```python
@pytest.mark.asyncio
async def test_endpoint_returns_expected(async_client: AsyncClient) -> None:
    # Arrange
    payload = {"email": "test@example.com", "password": "securepass123"}  # pragma: allowlist secret

    # Act
    response = await async_client.post("/auth/signup", json=payload)

    # Assert
    assert response.status_code == 200
    assert "token" in response.json()
```

**Key fixtures** (from conftest.py):
- `db_session` — clean SQLite in-memory session, tables created/dropped per test
- `async_client` — httpx AsyncClient with test DB injected
- `disable_rate_limit` — turns off rate limiting for tests needing many requests
- `_reset_rate_limiter` (autouse) — clears rate limiter between tests

**Common pitfalls:**
- Schema changes not reflected in test payloads → 422 errors
- Forgetting to use `disable_rate_limit` fixture → 429 errors
- Test ordering dependency from shared DB state → use `db_session` fixture

### Frontend (Jest + React Native Testing Library)

```typescript
import { render, fireEvent } from "@testing-library/react-native";

it("does the thing", () => {
  // Arrange
  const { getByText } = render(<Component />);

  // Act
  fireEvent.press(getByText("Button"));

  // Assert
  expect(getByText("Result")).toBeTruthy();
});
```

**Common pitfalls:**
- Timezone-sensitive tests — use `jest.useFakeTimers().setSystemTime(new Date('2025-06-15T12:00:00'))` (noon UTC, not midnight)
- Missing mocks for native modules (expo-secure-store, expo-notifications)
- Async state updates — wrap in `act()`

### Coverage

- Backend: 90% minimum (enforced by pytest-cov)
- Run: `cd backend && pytest --cov=. --cov-report=term-missing --cov-fail-under=90`
- Frontend: `cd frontend && npm test -- --watchAll=false`

## Troubleshooting

### Error: Tests are slow
- Backend tests use SQLite in-memory — should be fast
- If hanging, check for event loop issues or missing async/await
- Frontend: check for unresolved promises or missing timer mocks

### Error: Tests are flaky
- Look for shared state between tests (rate limiter, DB)
- Check for test order dependencies
- Mock time-dependent code with fake timers
- Avoid real network calls — mock API responses
