// Plain style fragments shared across the in-session ritual views. Exported as
// loose objects (not StyleSheet.create) so views can spread them into their own
// StyleSheet.create or compose them in flat style arrays.
import type { TextStyle, ViewStyle } from 'react-native';

import { BORDER_RADIUS, SPACING, colors, shadows } from '@/design/tokens';

/** Minimum width for a full-bleed session CTA. */
const SESSION_BUTTON_MIN_WIDTH = 220;

/** Height cap for a bounded internal-scroll list region inside a session widget. */
export const SESSION_LIST_MAX_HEIGHT = 220;

/** Height cap for the meditation card faces so controls stay on-screen on small phones. */
export const SESSION_CARD_MAX_HEIGHT = 420;

/** Shared geometry for the large filled session CTAs (Begin / Save / advance). */
export const SESSION_BUTTON_BASE: ViewStyle = {
  paddingVertical: SPACING.buttonV,
  paddingHorizontal: SPACING.xxl,
  borderRadius: BORDER_RADIUS.lg,
  minWidth: SESSION_BUTTON_MIN_WIDTH,
  alignItems: 'center',
  ...shadows.small,
};

/** Brand-primary fill for a Begin / advance CTA. */
export const PRIMARY_FILL: ViewStyle = { backgroundColor: colors.primary };

/** Success fill for a Save CTA. */
export const SUCCESS_FILL: ViewStyle = { backgroundColor: colors.success };

/** Light label text for a filled session CTA. */
export const SESSION_BUTTON_TEXT: TextStyle = {
  color: colors.text.light,
  fontSize: 18,
  fontWeight: '600',
};

/** Dimmed state for a disabled session CTA. */
export const SESSION_BUTTON_DISABLED: ViewStyle = { opacity: 0.5 };

/** Centered session ground padding. */
export const SESSION_CONTAINER: ViewStyle = { alignItems: 'center', padding: SPACING.xl };

/** Large tabular mm:ss timer readout. */
export const MEDITATION_TIMER_LABEL: TextStyle = {
  fontSize: 36,
  fontWeight: '300',
  fontVariant: ['tabular-nums'],
  marginBottom: SPACING.lg,
};

/** Uppercase small-caps caption label under a session readout. */
export const SESSION_CAPTION_LABEL: TextStyle = {
  fontSize: 14,
  textTransform: 'uppercase',
  letterSpacing: 2,
};

/** Large tabular time readout used by the interval-bell session views. */
export const SESSION_BIG_TIME: TextStyle = {
  fontSize: 48,
  fontWeight: '300',
  fontVariant: ['tabular-nums'],
};
