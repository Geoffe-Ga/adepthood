# sec-07: Push token stored in insecure AsyncStorage

**Labels:** `security`, `frontend`, `priority-high`
**Severity:** HIGH
**OWASP:** A02:2021 — Cryptographic Failures (insecure storage)
**Estimated LoC:** ~20

## Problem

The push notification token is stored in unencrypted AsyncStorage at
`frontend/src/storage/notificationStorage.ts:43-44`:

```typescript
export async function savePushToken(token: string): Promise<void> {
  await AsyncStorage.setItem(PUSH_TOKEN_KEY, token);
}
```

AsyncStorage stores data in plaintext on the device filesystem. On a rooted
Android device or jailbroken iOS device, any app can read this data. A leaked
push token allows an attacker to send push notifications to the user's device.

The codebase already correctly uses `expo-secure-store` for JWT tokens
(`frontend/src/storage/authStorage.ts`), establishing the pattern. The push
token storage is inconsistent with this established security practice.

## Tasks

1. **Migrate push token storage to `expo-secure-store`**
   ```typescript
   import * as SecureStore from 'expo-secure-store';

   const PUSH_TOKEN_KEY = 'adepthood_push_token';

   export async function savePushToken(token: string): Promise<void> {
     await SecureStore.setItemAsync(PUSH_TOKEN_KEY, token);
   }

   export async function loadPushToken(): Promise<string | null> {
     return await SecureStore.getItemAsync(PUSH_TOKEN_KEY);
   }
   ```

2. **Keep notification ID mappings in AsyncStorage**
   - Notification scheduling IDs (`saveNotificationIds`, `loadNotificationIds`)
     are non-sensitive and can remain in AsyncStorage
   - Only the push token itself needs encryption

3. **Update tests**
   - Mock `SecureStore` instead of `AsyncStorage` for push token tests

## Acceptance Criteria

- Push token stored via `expo-secure-store` (encrypted)
- Notification ID mappings remain in AsyncStorage (acceptable)
- Existing notification scheduling functionality unaffected

## Files to Modify

| File | Action |
|------|--------|
| `frontend/src/storage/notificationStorage.ts` | Use SecureStore for push token |
| `frontend/src/features/Habits/hooks/useHabitNotifications.ts` | Verify import path |
| `frontend/src/storage/__tests__/` | Update mocks |
