import { SPACING } from '@/design/tokens';

/**
 * Vertical padding for the action buttons on the Settings form screens.
 *
 * ``SPACING.md`` nudged up by 2 to balance the larger button-label font, shared
 * by both the API-key and time-zone screens so the two stay in visual parity
 * without a manual "keep in sync" comment.
 */
export const SETTINGS_BUTTON_PADDING = SPACING.md + 2;
