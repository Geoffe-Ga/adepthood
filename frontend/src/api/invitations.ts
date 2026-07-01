/**
 * Invitation API surface (subtle invitation surface, NORTH-STAR §6).
 *
 * Re-exports from ``./index`` so the Today feature has a discoverable module
 * path while the implementation lives alongside every other API namespace and
 * shares the retry/timeout/refresh middleware in ``request()``:
 *
 *     import { invitations, type Invitation } from '@/api/invitations';
 */
export { invitations, type Invitation } from './index';
