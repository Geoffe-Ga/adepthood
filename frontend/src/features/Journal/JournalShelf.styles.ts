/** Styles for the journal shelf (the editorial library of entry "pages"). */
import { StyleSheet } from 'react-native';

import {
  BORDER_RADIUS,
  SPACING,
  accent,
  colors,
  editorialType,
  ink,
  spacing,
  surface,
  surfaceShadow,
  touchTarget,
} from '@/design/tokens';

const PROMPT_ACCENT_BAR = 3; // the weekly prompt's identifying left rule
const HEADING_TRACKING = 1; // small-caps letter-spacing for recency headings

const styles = StyleSheet.create({
  list: {
    flex: 1,
  },
  listContent: {
    paddingBottom: SPACING.xxl,
    flexGrow: 1,
  },
  sectionHeading: {
    ...editorialType.caption,
    color: ink.muted,
    textTransform: 'uppercase',
    letterSpacing: HEADING_TRACKING,
    marginTop: SPACING.lg,
    marginBottom: SPACING.sm,
  },
  card: {
    minHeight: touchTarget.minimum,
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.lg,
    marginBottom: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    // A warm paper tile lifted off the canvas by the shared card shadow;
    // separation comes from the gap + shadow, not a hairline divider.
    backgroundColor: surface.desk,
    ...surfaceShadow.card,
  },
  cardTitleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  cardTitle: {
    ...editorialType.title,
    color: ink.primary,
    flexShrink: 1,
  },
  cardDate: {
    ...editorialType.caption,
    color: ink.soft,
    paddingLeft: SPACING.sm,
  },
  cardExcerpt: {
    ...editorialType.note,
    color: ink.soft,
    paddingTop: spacing(0.5),
  },
  cardCaption: {
    ...editorialType.caption,
    color: ink.muted,
    paddingTop: spacing(0.5),
  },
  searchRow: {
    marginBottom: SPACING.sm,
  },
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.xl,
    paddingTop: SPACING.xxl,
  },
  emptyText: {
    ...editorialType.body,
    color: ink.soft,
    textAlign: 'center',
  },
  emptyError: {
    ...editorialType.body,
    color: colors.danger,
    textAlign: 'center',
  },
  promptCard: {
    marginTop: SPACING.lg,
    padding: SPACING.lg,
    borderRadius: BORDER_RADIUS.md,
    // Lifted onto a raised sheet, but keeps an accent bar marking it the prompt.
    backgroundColor: surface.raised,
    borderLeftWidth: PROMPT_ACCENT_BAR,
    borderLeftColor: accent.primary,
    ...surfaceShadow.card,
  },
  promptLabel: {
    ...editorialType.caption,
    color: ink.muted,
    textTransform: 'uppercase',
  },
  promptQuestion: {
    ...editorialType.title,
    color: ink.primary,
    paddingTop: spacing(0.5),
  },
});

export default styles;
