/**
 * Practice share-link API surface (issue #348).
 *
 * Re-exports from ``./index`` so this feature has a discoverable module
 * path (per the issue's file list) while the actual implementation
 * lives alongside every other API namespace and shares the
 * retry/timeout/refresh middleware in ``request()``.
 *
 * Consumers should import from this module rather than reaching into
 * ``@/api`` for the share-specific surface:
 *
 *     import { practiceShare, type ShareLinkPreviewResponse } from '@/api/practiceShare';
 */
export {
  practiceShare,
  type ShareLinkCreateRequest,
  type ShareLinkImportResponse,
  type ShareLinkPreviewResponse,
  type ShareLinkResponse,
} from './index';
