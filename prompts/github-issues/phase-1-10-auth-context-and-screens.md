# phase-1-10: Build AuthContext with secure token storage and login/signup screens

**Labels:** `phase-1`, `frontend`, `security`, `priority-critical`
**Epic:** Phase 1 — Make It Real
**Depends on:** phase-1-03, phase-1-07, phase-1-09
**Estimated LoC:** ~300

## Problem

There is no way for a user to log in. The frontend has:
- No login screen
- No signup screen
- No AuthContext or auth state management
- No way to check if the user is authenticated
- No redirect to login when a token expires
- No logout mechanism

The auth token is stored in a module-level variable in the now-deleted `client.ts` (`let authToken: string | null = null`) — which resets to null on every app restart. The `AppContext.tsx` file is empty (1 line).

The backend has working `/auth/signup` and `/auth/login` endpoints (being migrated to DB in phase-1-03), but nothing on the frontend calls them.

## Scope

Build the complete authentication flow: context, screens, token management, and route protection.

## Tasks

1. **Create `frontend/src/context/AuthContext.tsx`**
   - `AuthProvider` component wrapping the app
   - State: `user: { id: number; email: string } | null`, `token: string | null`, `isLoading: boolean`
   - Actions: `login(email, password)`, `signup(email, password)`, `logout()`
   - On mount: check secure storage for existing token, validate it, set user state
   - On login/signup: store token in `expo-secure-store`, set user state
   - On logout: clear secure storage, clear user state, navigate to login
   - Export `useAuth()` hook for consuming components

2. **Replace the empty `AppContext.tsx`**
   - Either repurpose it as a combined provider or delete it and use `AuthContext` directly
   - The file is currently 1 line and unused

3. **Create `frontend/src/features/Auth/LoginScreen.tsx`**
   - Email and password fields
   - Login button that calls `useAuth().login()`
   - Link to signup screen
   - Error display for invalid credentials
   - Loading state while authenticating

4. **Create `frontend/src/features/Auth/SignupScreen.tsx`**
   - Email, password, confirm password fields
   - Password validation (minimum 8 chars, matching confirmation)
   - Signup button that calls `useAuth().signup()`
   - Link to login screen
   - Error display for duplicate email, weak password, etc.

5. **Add route protection in `App.tsx`**
   - If `user` is null and not loading: show Login/Signup stack
   - If `user` is set: show BottomTabs
   - This is the standard React Navigation auth flow pattern

6. **Update `api/index.ts` request function**
   - Automatically include the auth token from AuthContext (or from secure storage)
   - If a request returns 401, trigger logout (token expired)

7. **Update `BottomTabs.tsx`**
   - Add a logout button (in a settings tab or header)

## Acceptance Criteria

- New users can sign up and are redirected to the main app
- Returning users see a login screen if their token expired
- Returning users go straight to the app if their token is valid
- Logout clears all stored state and returns to login
- 401 responses from any API call trigger automatic logout
- Auth token is stored in `expo-secure-store`, not AsyncStorage or module variables

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/context/AuthContext.tsx` | **Rewrite** (currently empty) |
| `frontend/src/features/Auth/LoginScreen.tsx` | **Create** |
| `frontend/src/features/Auth/SignupScreen.tsx` | **Create** |
| `frontend/src/App.tsx` | Modify (auth-gated routing) |
| `frontend/src/navigation/BottomTabs.tsx` | Modify (add logout) |
| `frontend/src/api/index.ts` | Modify (auto-include token, handle 401) |
