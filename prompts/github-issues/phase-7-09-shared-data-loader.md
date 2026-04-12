# Phase 6-09: Shared Data-Loading Pattern

## Problem

Every feature screen re-implements the same "fetch data + loading + error + retry" pattern differently:

- `useHabits` (line 324-334) — custom try/catch with `handleApiSuccess`/`handleApiError`
- `CourseScreen` (line 66-91) — inline `Promise.all` with manual `setLoadingContent`
- `PracticeScreen` (line 85-126) — three separate hooks with overlapping responsibilities
- `JournalScreen` (line 150+) — inline pagination state management

Each has different error handling, different loading patterns, and no retry logic.

## Fix

### Create `useDataLoader` Hook

```typescript
// src/hooks/useDataLoader.ts
export function useDataLoader<T>(
  fetcher: () => Promise<T>,
  options?: { enabled?: boolean; retryCount?: number }
): {
  data: T | null;
  loading: boolean;
  error: string | null;
  retry: () => void;
  refresh: () => void;
} {
  // Handles: initial fetch, loading state, error state, retry with backoff, refresh
  // Cleans up on unmount (prevents setState on unmounted component)
}
```

### Create `usePaginatedLoader` Hook

```typescript
// src/hooks/usePaginatedLoader.ts
export function usePaginatedLoader<T>(
  fetcher: (offset: number, limit: number) => Promise<{ items: T[]; total: number }>,
  options?: { pageSize?: number }
): {
  items: T[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore: () => void;
  refresh: () => void;
}
```

### Migrate Feature Screens

Replace custom fetch logic in each screen with the shared hooks. Each screen should be ~30 lines shorter.

## Acceptance Criteria

- [ ] `useDataLoader` handles loading/error/retry for single-fetch endpoints
- [ ] `usePaginatedLoader` handles pagination for list endpoints
- [ ] All 5 feature screens use the shared hooks
- [ ] Retry with exponential backoff (1s, 2s, 4s, max 3 attempts)
- [ ] Cleanup on unmount prevents React warnings
- [ ] All existing tests pass

## Estimated Scope
~200 LoC
