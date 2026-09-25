/**
 * Presentation of the live Markdown mirror -- Candle & Ink tokens only.
 *
 * Layering: the mirror sits BEHIND the real textarea. The textarea is on
 * top with a transparent background and a transparent glyph FILL, so the
 * caret, the selection highlight, spelling marks and the IME composition
 * underline all paint above everything the mirror draws, the quote wash
 * included. ``color`` stays ink (those marks are drawn in it); only
 * ``-webkit-text-fill-color`` is transparent, and ``caret-color`` is the
 * writing caret token. Over the textarea, the mirror's opaque quote wash hid
 * the caret and selection on quote lines.
 *
 * Every style here is ADVANCE-NEUTRAL: it may change colour, a shadow or a
 * decoration, but never a glyph's width, because the mirror's characters sit
 * exactly under the transparent characters of the real textarea. Hence faux bold (a
 * same-ink text shadow) instead of a heavier weight, and italic shown as an
 * upright accent-ink run: a true italic face has different advances and would
 * drift every later glyph on the line. Read mode keeps the real bold weight and
 * italic face.
 */
import { StyleSheet, type TextStyle } from 'react-native';

import { LIVE_BODY_FONT, LIVE_BODY_INSET } from './JournalEntry.styles';
import { JOURNAL_TAB_COLUMNS } from './journalMarkdown';

import { accent, colors, writingField } from '@/design/tokens';

/** Horizontal offset, in px, of the same-ink shadow that thickens faux bold. */
export const FAUX_BOLD_OFFSET = 0.6;

/**
 * Tab stops at the model's own column width, on the textarea AND the mirror.
 * ``tabSize`` is a react-native-web CSS passthrough absent from RN's
 * ``TextStyle`` (the ``writingFieldFocus`` precedent), and is only attached
 * when the mirror is -- on web.
 */
export const LIVE_TAB_STYLE = { tabSize: JOURNAL_TAB_COLUMNS } as unknown as TextStyle;

/**
 * The field's web-only paint over the mirror: glyph fill transparent, caret
 * in the writing caret token. Both are CSS passthroughs absent from RN's
 * ``TextStyle``, attached only while the mirror is on (web).
 */
export const LIVE_FIELD_WEB_STYLE = {
  WebkitTextFillColor: 'transparent',
  caretColor: writingField.caret,
} as unknown as TextStyle;

/** Stacking: the field above the mirror. */
const MIRROR_LAYER = 0;
const FIELD_LAYER = 1;

const liveStyles = StyleSheet.create({
  frame: {
    flexGrow: 1,
    position: 'relative',
  },
  /**
   * Laid exactly under the field, ignoring the pointer. It carries the field's
   * inset itself: its text is inline, and inline padding would move no line.
   */
  mirror: {
    zIndex: MIRROR_LAYER,
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    ...LIVE_BODY_INSET,
  },
  /** The field's own glyph metrics, and nothing that would box the inline text. */
  mirrorText: {
    ...LIVE_BODY_FONT,
    color: colors.paper.ink,
  },
  /** The real textarea over the mirror: see-through, so only its caret and marks show. */
  inputMirrored: {
    position: 'relative',
    zIndex: FIELD_LAYER,
    color: colors.paper.ink,
    backgroundColor: 'transparent',
    // The field grows to its content and never scrolls (scrollEnabled=false);
    // without this a transient scrollbar would narrow its lines and not the mirror's.
    overflow: 'hidden',
  },
  /**
   * Block markers and delimiters the caret is not inside: the soft ink, set
   * apart from content by hue rather than faded -- they are characters the
   * writer typed and edits, so they keep text contrast (7.3:1).
   */
  dimmed: {
    color: colors.paper.inkSoft,
  },
  /** Delimiters around the caret come up to the content's full ink. */
  revealed: {
    color: colors.paper.ink,
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
