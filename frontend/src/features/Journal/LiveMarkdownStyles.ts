/**
 * Presentation of the live Markdown mirror -- Candle & Ink tokens only.
 *
 * Every style here is ADVANCE-NEUTRAL: it may change colour, opacity, a
 * shadow or a decoration, but never a glyph's width, because the mirror's
 * characters sit exactly under the transparent characters of the real
 * textarea and the caret is drawn by the textarea. Hence faux bold (a
 * same-ink text shadow) instead of a heavier weight, and italic shown as an
 * upright accent-ink run: a true italic face has different advances and would
 * drift every later glyph on the line. Read mode keeps the real bold weight and
 * italic face.
 */
import { StyleSheet, type TextStyle } from 'react-native';

import { LIVE_BODY_METRICS } from './JournalEntry.styles';
import { JOURNAL_TAB_COLUMNS } from './journalMarkdown';

import { accent, colors } from '@/design/tokens';

/** Opacity of a block marker or delimiter the caret is not inside. */
export const MIRROR_HIDDEN_OPACITY = 0.45;

/** Horizontal offset, in px, of the same-ink shadow that thickens faux bold. */
export const FAUX_BOLD_OFFSET = 0.6;

/**
 * Tab stops at the model's own column width, on the textarea AND the mirror.
 * ``tabSize`` is a react-native-web CSS passthrough absent from RN's
 * ``TextStyle`` (the ``writingFieldFocus`` precedent), and is only attached
 * when the mirror is -- on web.
 */
export const LIVE_TAB_STYLE = { tabSize: JOURNAL_TAB_COLUMNS } as unknown as TextStyle;

const liveStyles = StyleSheet.create({
  frame: {
    flexGrow: 1,
    position: 'relative',
  },
  /**
   * Laid exactly over the field and above it, ignoring the pointer: clicks,
   * drags and taps reach the textarea, while the field's own selection
   * highlight and caret paint beneath the styled glyphs instead of over them.
   */
  mirror: {
    zIndex: 1,
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  mirrorText: {
    ...LIVE_BODY_METRICS,
    color: colors.paper.ink,
  },
  /** The real textarea over the mirror: caret and selection only, no glyphs of its own. */
  inputMirrored: {
    color: 'transparent',
    backgroundColor: 'transparent',
  },
  dimmed: {
    color: colors.paper.inkSoft,
    opacity: MIRROR_HIDDEN_OPACITY,
  },
  revealed: {
    color: colors.paper.inkSoft,
    opacity: 1,
  },
  bold: {
    textShadowColor: colors.paper.ink,
    textShadowOffset: { width: FAUX_BOLD_OFFSET, height: 0 },
    textShadowRadius: 0,
  },
  italic: {
    color: accent.strong,
  },
  underline: {
    textDecorationLine: 'underline',
  },
  quoteLine: {
    backgroundColor: colors.paper.backgroundAlt,
  },
});

export default liveStyles;
