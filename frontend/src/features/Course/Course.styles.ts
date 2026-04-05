import { StyleSheet } from 'react-native';

import { colors, radius, SPACING, shadows } from '../../design/tokens';

const STAGE_PILL_SIZE = 40;
const PROGRESS_BAR_HEIGHT = 6;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background.primary,
  },

  // Stage selector
  stageSelectorContainer: {
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.background.card,
  },
  stageSelectorContent: {
    paddingHorizontal: SPACING.md,
    gap: SPACING.sm,
  },
  stagePill: {
    width: STAGE_PILL_SIZE,
    height: STAGE_PILL_SIZE,
    borderRadius: STAGE_PILL_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  stagePillActive: {
    borderColor: colors.primary,
    ...shadows.medium,
  },
  stagePillLocked: {
    opacity: 0.4,
  },
  stagePillCompleted: {
    opacity: 0.8,
  },
  stagePillText: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.text.light,
  },
  stagePillCheck: {
    fontSize: 16,
    color: colors.text.light,
  },
  stagePillLock: {
    fontSize: 14,
    color: colors.text.light,
  },

  // Stage metadata
  stageMetadata: {
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    backgroundColor: colors.background.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  stageTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text.primary,
    marginBottom: 2,
  },
  stageSubtitle: {
    fontSize: 14,
    color: colors.text.secondary,
    marginBottom: SPACING.sm,
  },
  stageDetailRow: {
    flexDirection: 'row',
    gap: SPACING.md,
    marginBottom: 4,
  },
  stageDetailLabel: {
    fontSize: 12,
    color: colors.text.tertiary,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  stageDetailValue: {
    fontSize: 12,
    color: colors.text.secondary,
  },

  // Progress bar
  progressBarContainer: {
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    backgroundColor: colors.background.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  progressBarTrack: {
    height: PROGRESS_BAR_HEIGHT,
    borderRadius: PROGRESS_BAR_HEIGHT / 2,
    backgroundColor: colors.background.accent,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: PROGRESS_BAR_HEIGHT,
    borderRadius: PROGRESS_BAR_HEIGHT / 2,
  },
  progressBarLabel: {
    fontSize: 12,
    color: colors.text.tertiary,
    marginTop: 4,
    textAlign: 'right',
  },

  // Content card
  contentCard: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    backgroundColor: colors.background.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  contentCardLocked: {
    opacity: 0.5,
  },
  contentCardRead: {
    opacity: 0.7,
  },
  contentCardIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: SPACING.md,
  },
  contentCardIconText: {
    fontSize: 18,
  },
  contentCardBody: {
    flex: 1,
  },
  contentCardTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text.primary,
    marginBottom: 2,
  },
  contentCardSubtitle: {
    fontSize: 13,
    color: colors.text.secondary,
  },
  contentCardStatus: {
    marginLeft: SPACING.sm,
  },
  contentCardStatusText: {
    fontSize: 16,
  },

  // Content viewer
  viewerContainer: {
    flex: 1,
    backgroundColor: colors.background.primary,
  },
  viewerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.background.card,
  },
  viewerBackButton: {
    paddingRight: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  viewerBackText: {
    fontSize: 16,
    color: colors.secondary,
    fontWeight: '600',
  },
  viewerTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    color: colors.text.primary,
  },
  viewerFooter: {
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.background.card,
  },
  markReadButton: {
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    borderRadius: radius.md,
    backgroundColor: colors.success,
    alignItems: 'center',
  },
  markReadButtonDone: {
    backgroundColor: colors.background.accent,
  },
  markReadText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.text.light,
  },
  markReadTextDone: {
    color: colors.text.secondary,
  },

  // Loading and empty states
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.xl,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: SPACING.md,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.text.primary,
    marginBottom: SPACING.sm,
    textAlign: 'center',
  },
  emptySubtitle: {
    fontSize: 14,
    color: colors.text.secondary,
    textAlign: 'center',
    lineHeight: 20,
  },

  // Content list
  contentList: {
    flex: 1,
  },
});

export default styles;
