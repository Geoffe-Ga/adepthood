/**
 * Styles for the Journal photograph-capture screen — the editorial "paper" idiom
 * shared with the writing surface (warm paper ground, serif body). Tokens only.
 */
import { StyleSheet } from 'react-native';

import { BORDER_RADIUS, SPACING, colors, editorialType, spacing } from '@/design/tokens';

/** Minimum height for the editable preview so a short transcription still reads
 *  as a full page rather than a cramped single-line field. */
const PREVIEW_MIN_HEIGHT = spacing(30);

const styles = StyleSheet.create({
  /** Vertical stack for a phase's copy + affordances, with editorial breathing room. */
  container: {
    flex: 1,
    gap: SPACING.md,
  },
  heading: {
    ...editorialType.title,
    color: colors.paper.ink,
  },
  message: {
    ...editorialType.body,
    color: colors.paper.inkSoft,
  },
  /** The quiet "reading your page" block shown while transcription is in flight. */
  fillingBlock: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.paper.hairline,
    backgroundColor: colors.paper.background,
  },
  /** The editable transcription preview: a growing, top-aligned paper field. */
  previewInput: {
    flexGrow: 1,
    minHeight: PREVIEW_MIN_HEIGHT,
    ...editorialType.body,
    color: colors.paper.ink,
    backgroundColor: colors.paper.background,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.paper.hairline,
    padding: SPACING.md,
    textAlignVertical: 'top',
  },
  /** Stacked action buttons under a phase's copy. */
  actions: {
    gap: SPACING.sm,
  },
});

export default styles;
