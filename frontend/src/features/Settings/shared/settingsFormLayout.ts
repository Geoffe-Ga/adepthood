import { StyleSheet } from 'react-native';

import { BORDER_RADIUS, SPACING, accent, colors, ink, type as typeRamp } from '@/design/tokens';

/**
 * Vertical padding for the action buttons on the Settings form screens.
 *
 * ``SPACING.md`` nudged up by 2 to balance the larger button-label font, shared
 * by both the API-key and time-zone screens so the two stay in visual parity
 * without a manual "keep in sync" comment.
 */
export const SETTINGS_BUTTON_PADDING = SPACING.md + 2;

/**
 * Monospace face for rendering stored technical values (API keys, IANA zone
 * names) on the Settings form screens.
 */
export const SETTINGS_MONOSPACE_FONT = 'Menlo';

/**
 * Letter spacing for the small uppercase card labels ("Stored on this device",
 * "Current time zone") on the Settings form screens.
 */
export const SETTINGS_CARD_LABEL_LETTER_SPACING = 0.5;

/**
 * Style tokens shared verbatim by the API-key and time-zone settings forms.
 *
 * Consolidating them here keeps the two sibling screens in visual parity: a
 * single edit updates both, so they can no longer drift silently. Screen-only
 * tokens (input rows, card bodies, secondary/destructive buttons) stay local to
 * each screen.
 */
export const settingsFormStyles = StyleSheet.create({
  /** Spacing and ink only: the face is ``settingsFormType(width).title``. */
  title: { marginBottom: SPACING.md, color: ink.primary },
  /**
   * The small uppercase card label ("Stored on this device", "Current time
   * zone"); the face is ``settingsFormType(width).cardLabel``. Never a control.
   */
  cardLabel: {
    color: ink.muted,
    textTransform: 'uppercase',
    letterSpacing: SETTINGS_CARD_LABEL_LETTER_SPACING,
  },
  body: {
    fontSize: 14,
    color: ink.soft,
    marginBottom: SPACING.xl,
    lineHeight: 20,
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: SPACING.sm,
    color: ink.primary,
  },
  primaryButton: {
    borderRadius: BORDER_RADIUS.md,
    padding: SETTINGS_BUTTON_PADDING,
    alignItems: 'center',
    backgroundColor: accent.primary,
    marginTop: SPACING.xs,
  },
  primaryButtonText: { color: colors.text.light, fontSize: 16, fontWeight: '600' },
  linkRow: { marginTop: SPACING.xl, alignItems: 'center' },
  link: { color: accent.primary, fontWeight: '600' },
});

/**
 * The width-dependent faces of the Settings form family (#2962), from the
 * Candle & Ink ramp: a form title grows with the window (26 on a phone, 30 on
 * a desktop), and a card label is the ramp caption. A StyleSheet cannot read
 * the width, so each screen spreads these under the matching
 * ``settingsFormStyles`` entry, which carries only spacing and ink.
 */
export const settingsFormType = (width: number) => {
  const t = typeRamp(width);
  return { title: t.title, cardLabel: t.caption } as const;
};
