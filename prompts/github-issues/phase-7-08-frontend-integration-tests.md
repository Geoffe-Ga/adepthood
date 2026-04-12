# Phase 6-08: Add Frontend Integration Tests

## Problem

Frontend tests are unit-level only. Missing integration tests for critical user flows:

- Habit creation → goal update → completion logging → streak display
- Auth flow: login → token refresh → 401 retry → re-login
- Navigation: deep link to Journal with course reflection params
- Modal coordination: open settings → reorder habits → save → close
- BotMason chat: send message → loading state → response displayed → balance updated

## Tests to Write

### 1. Habit Lifecycle (`__tests__/integration/habit-lifecycle.test.tsx`)
```
render HabitsScreen with mock API
→ press "Add Habit"
→ fill form, save
→ verify habit appears in list
→ tap habit, log completion
→ verify streak updates
→ open stats modal
→ verify stats displayed
```

### 2. Auth Token Refresh (`__tests__/integration/auth-refresh.test.tsx`)
```
render App with expired token
→ API call returns 401
→ verify refresh token request sent
→ verify original request retried with new token
→ verify user stays logged in
```

### 3. BotMason Chat (`__tests__/integration/botmason-chat.test.tsx`)
```
render JournalScreen with balance > 0
→ type message, press send
→ verify loading indicator appears
→ mock API returns response
→ verify bot message displayed
→ verify balance decremented
```

### 4. Cross-Feature Navigation (`__tests__/integration/deep-links.test.tsx`)
```
navigate to Course screen
→ tap "Reflect" on content item
→ verify navigation to Journal with correct params (tag, stageNumber, contentTitle)
→ verify Journal pre-fills reflection context
```

## Acceptance Criteria

- [ ] 4 integration test files covering critical user flows
- [ ] Tests use React Native Testing Library (user-centric, not implementation-centric)
- [ ] No flaky tests (deterministic mocks, no timing dependencies)
- [ ] Tests run in <10 seconds total

## Estimated Scope
~350 LoC
