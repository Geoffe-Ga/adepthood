/** Styles for the journal shelf (the editorial library of entry "pages"). */
import { StyleSheet } from 'react-native';

import {
  BORDER_RADIUS,
  SPACING,
  accent,
  colors,
  editorialType,
  ink,
  rhythm,
  spacing,
  surface,
  surfaceShadow,
  touchTarget,
} from '@/design/tokens';

const PROMPT_ACCENT_BAR = 3; // a stage prompt's identifying left rule
// An answered prompt stays legible and stays tappable — it recedes rather than
// greys out, since several of a stage's prompts are meant to be returned to.
const ANSWERED_OPACITY = 0.7;
const HEADING_TRACKING = 1; // small-caps letter-spacing for recency headings

const styles = StyleSheet.create({
  list: {
    flex: 1,
  },
  listContent: {
    paddingBottom: rhythm.bottomFadeHeight,
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
  // The reading face, not the heading face: on a shelf of the writer's own
  // pages the words should be the loudest thing, so the card carries exactly
  // one full-ink line and separates from the excerpt by colour, not weight.
  cardTitle: {
    ...editorialType.body,
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
  // Sits below the reading face, right-aligned, on the 44dp tap floor. The
  // interactive `action` face rather than `caption`: it is meant to be pressed.
  cardDeleteButton: {
    minHeight: touchTarget.minimum,
    alignSelf: 'flex-end',
    justifyContent: 'center',
    paddingLeft: SPACING.lg,
  },
  cardDeleteLabel: {
    ...editorialType.action,
    color: colors.danger,
    fontWeight: '400',
  },
  // Where the ScreenHeader's action slot used to sit: the same vertical rhythm,
  // now carrying "New entry" alone, with no display-scale title above it.
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingVertical: rhythm.heroPaddingV,
  },
  searchRow: {
    marginBottom: SPACING.sm,
  },
  deleteError: {
    ...editorialType.note,
    color: colors.danger,
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.sm,
  },
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.xl,
    paddingTop: SPACING.xxl,
  },
  emptyCtaGroup: {
    alignItems: 'center',
    gap: SPACING.sm,
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
  promptSection: {
    marginTop: SPACING.lg,
  },
  promptSectionLabel: {
    ...editorialType.caption,
    color: ink.muted,
    paddingBottom: spacing(0.5),
  },
  promptSectionNote: {
    ...editorialType.caption,
    color: ink.muted,
    paddingBottom: spacing(0.5),
  },
  promptCard: {
    marginTop: SPACING.sm,
    padding: SPACING.lg,
    borderRadius: BORDER_RADIUS.md,
    // Lifted onto a raised sheet, but keeps an accent bar marking it the prompt.
    backgroundColor: surface.raised,
    borderLeftWidth: PROMPT_ACCENT_BAR,
    borderLeftColor: accent.primary,
    ...surfaceShadow.card,
  },
  promptCardAnswered: {
    opacity: ANSWERED_OPACITY,
  },
  promptLabel: {
    ...editorialType.caption,
    color: ink.muted,
  },
  promptAnswered: {
    ...editorialType.caption,
    color: accent.primary,
    paddingTop: spacing(0.5),
  },
  promptQuestion: {
    ...editorialType.heading,
    color: ink.primary,
    paddingTop: spacing(0.5),
  },
});

export default styles;
