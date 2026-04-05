// frontend/features/Map/Map.styles.ts

import { StyleSheet } from 'react-native';

import { colors, radius, shadows, spacing } from '../../design/tokens';

/**
 * Mystical-aesthetic styles for the Map screen.
 * Supports hotspot overlays, rich stage detail modal, glow effects,
 * and visual states for locked/current/completed stages.
 */
const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
  },

  // Loading / error states
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    color: colors.text.light,
    fontSize: 14,
    marginTop: spacing(1),
  },
  errorText: {
    color: colors.danger,
    fontSize: 14,
    textAlign: 'center',
    paddingHorizontal: spacing(2),
  },

  // Hotspot touch targets (transparent overlays on the background image)
  hotspot: {
    position: 'absolute',
    backgroundColor: 'rgba(255,255,255,0.01)',
  },
  hotspotLocked: {
    opacity: 0.4,
  },
  hotspotCurrent: {
    borderWidth: 2,
    borderColor: colors.mystical.glowLight,
    borderRadius: radius.sm,
  },
  hotspotCompleted: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
    borderRadius: radius.sm,
  },

  // Lock icon overlay for locked stages
  lockOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lockText: {
    fontSize: 14,
    color: colors.text.light,
    opacity: 0.7,
  },

  // Stage connection lines between stages
  connectionLine: {
    position: 'absolute',
    width: 2,
    backgroundColor: 'rgba(255,255,255,0.15)',
  },

  // Modal overlay and content
  modalOverlay: {
    flex: 1,
    backgroundColor: colors.mystical.overlay,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    width: '85%',
    maxHeight: '80%',
    backgroundColor: colors.secondary,
    padding: spacing(2.5),
    borderRadius: radius.lg,
    position: 'relative',
    ...shadows.large,
  },

  // Close button
  closeButton: {
    position: 'absolute',
    top: spacing(1),
    right: spacing(1),
    padding: spacing(0.5),
    zIndex: 1,
  },
  closeText: {
    fontSize: 20,
    fontWeight: '600',
    color: colors.text.light,
  },

  // Stage color indicator dot
  colorDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginRight: spacing(1),
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing(0.5),
    paddingRight: spacing(3),
  },

  // Title and subtitle
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.text.light,
  },
  modalSubtitle: {
    fontSize: 14,
    color: colors.mystical.transparentLight,
    marginBottom: spacing(1.5),
    fontStyle: 'italic',
  },

  // Progress bar
  progressContainer: {
    marginBottom: spacing(1.5),
  },
  progressLabel: {
    fontSize: 12,
    color: colors.mystical.transparentLight,
    marginBottom: spacing(0.5),
  },
  progressBar: {
    height: 8,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: radius.sm,
  },

  // Rich metadata section
  metadataSection: {
    marginBottom: spacing(1.5),
  },
  metadataRow: {
    flexDirection: 'row',
    marginBottom: spacing(0.5),
  },
  metadataLabel: {
    fontSize: 12,
    color: colors.mystical.transparentLight,
    width: 100,
    fontWeight: '600',
  },
  metadataValue: {
    fontSize: 12,
    color: colors.text.light,
    flex: 1,
  },
  freeWillDescription: {
    fontSize: 12,
    color: colors.mystical.transparentLight,
    marginTop: spacing(0.5),
    lineHeight: 18,
    fontStyle: 'italic',
  },

  // Separator
  separator: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.1)',
    marginVertical: spacing(1.5),
  },

  // Quick action buttons
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing(1),
  },
  actionButton: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.1)',
    paddingVertical: spacing(1),
    paddingHorizontal: spacing(1.5),
    borderRadius: radius.md,
    alignItems: 'center',
  },
  actionText: {
    fontSize: 13,
    color: colors.text.light,
    fontWeight: '600',
  },

  // Completed stage checkmark
  completedBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.success,
    alignItems: 'center',
    justifyContent: 'center',
  },
  completedBadgeText: {
    fontSize: 11,
    color: colors.text.light,
    fontWeight: '700',
  },
});

export default styles;
