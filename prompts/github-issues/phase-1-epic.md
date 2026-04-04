# EPIC: Phase 1 — Make It Real

**Labels:** `epic`, `phase-1`, `priority-critical`

## Summary

The app currently has zero persistence on both frontend and backend. Every router stores data in Python lists/dicts that vanish on restart. The frontend holds all state in `useState` with hardcoded defaults. SQLModel models exist but are never queried. Two competing API clients exist on the frontend but neither is called by any screen.

This phase wires up the real infrastructure: database, auth flow, API integration, and offline storage. Without this, nothing else matters — the app is a interactive mockup.

## Success Criteria

- Backend routers query a real PostgreSQL database via SQLModel
- Frontend screens call real API endpoints and display server data
- Users can sign up, log in, and have their session persist across app restarts
- Habit data survives app and server restarts
- A single, consistent API client is used across all frontend screens

## Sub-Issues

1. `phase-1-01` — Create database engine, session management, and Alembic setup
2. `phase-1-02` — Migrate habits router from in-memory list to database queries
3. `phase-1-03` — Migrate auth router from in-memory dicts to database-backed users/sessions
4. `phase-1-04` — Migrate practice router from in-memory list to database queries
5. `phase-1-05` — Migrate goal_completions router from in-memory dict to database queries
6. `phase-1-06` — Migrate energy router idempotency cache to database or TTL cache
7. `phase-1-07` — Consolidate frontend API clients into a single module
8. `phase-1-08` — Connect HabitsScreen to the habits API (read + write)
9. `phase-1-09` — Add AsyncStorage persistence layer for offline habit state
10. `phase-1-10` — Build AuthContext with secure token storage and login/signup screens
11. `phase-1-11` — Align frontend and backend Habit type definitions
