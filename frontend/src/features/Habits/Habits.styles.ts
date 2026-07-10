import { Platform, StyleSheet, type ViewStyle } from 'react-native';

import {
  accent,
  colors as COLORS,
  fonts,
  ink,
  shadows as SHADOWS,
  SPACING,
  BORDER_RADIUS,
  surface,
  surfaceShadow,
  touchTarget,
} from '../../design/tokens';

const JUSTIFY_SPACE_BETWEEN = 'space-between' as const;

// Device dimensions (for responsive layouts)

//------------------
// Styles (modernized mystical minimalist style)
//------------------

// Group styles logically by component/feature
export const styles = StyleSheet.create({
  // ===== Layout containers =====
  container: {
    flex: 1,
    backgroundColor: surface.canvas,
    padding: SPACING.md,
  },
  habitsGrid: {
    justifyContent: JUSTIFY_SPACE_BETWEEN,
  },

  // ===== Habit Tiles =====
  icon: {
    fontSize: 40,
    marginTop: SPACING.sm,
    marginBottom: SPACING.xs,
  },
  iconLarge: {
    fontSize: 24,
  },
  // ===== Modals =====
  modalOverlay: {
    flex: 1,
    backgroundColor: COLORS.mystical.overlay,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    width: '90%',
    maxHeight: '80%',
    backgroundColor: COLORS.background.card,
    borderRadius: BORDER_RADIUS.xl,
    padding: SPACING.lg,
    borderTopWidth: 5,
    ...SHADOWS.large,
  },
  // ===== Days Selector =====
  dayOption: {
    backgroundColor: surface.sunken,
    borderWidth: 1,
    borderColor: surface.hairline,
    padding: SPACING.sm,
    borderRadius: BORDER_RADIUS.xs,
    margin: 2,
  },
  selectedDayOption: {
    backgroundColor: accent.primary,
  },
  dayOptionText: {
    fontSize: 12,
    color: ink.primary,
  },
  dayOptionTextSelected: {
    color: accent.onPrimary,
  },

  // ===== Action Buttons =====
  // The footer holds two fixed-min-width children (the ~204pt log-date stepper
  // and the ~190pt input + "Log Units" group) whose combined width exceeds the
  // modal content box on phone-sized viewports. RN Views can't shrink
  // (flexShrink: 0) and don't clip overflow, so without wrap the button paints
  // past the modal's right edge. flexWrap lets the group drop to a second line
  // when tight while staying single-line on wide (tablet/desktop) layouts; the
  // rowGap keeps the wrapped rows from touching.
  actionButtons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    rowGap: SPACING.sm,
    justifyContent: JUSTIFY_SPACE_BETWEEN,
    marginTop: SPACING.lg,
    paddingTop: SPACING.md,
    borderTopWidth: 1,
    borderColor: '#eee',
  },
  logUnitContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },

  // Improved input field
  logUnitInput: {
    borderWidth: 1,
    borderColor: COLORS.background.accent,
    padding: 10,
    width: 60,
    marginRight: 10,
    borderRadius: SPACING.md,
    textAlign: 'center',
    fontSize: 16,
  },

  // ===== Settings Modal =====
  settingsModalContent: {
    width: '90%',
    maxHeight: '90%',
    backgroundColor: COLORS.background.card,
    borderRadius: BORDER_RADIUS.xl,
    padding: SPACING.lg,
    borderTopWidth: 5,
    ...SHADOWS.large,
  },
  editModalCard: {
    width: '90%',
    maxHeight: '90%',
    backgroundColor: surface.raised,
    borderRadius: BORDER_RADIUS.xl,
    padding: SPACING.lg,
    borderTopWidth: 5,
    ...surfaceShadow.raised,
  },
  settingsContainer: {
    marginTop: SPACING.md,
  },
  settingGroup: {
    marginVertical: SPACING.md,
    borderBottomWidth: 1,
    borderColor: surface.hairline,
    paddingBottom: SPACING.md,
  },
  settingRow: {
    flexDirection: 'row',
    justifyContent: JUSTIFY_SPACE_BETWEEN,
    alignItems: 'center',
    marginVertical: SPACING.sm,
  },
  settingLabel: {
    fontWeight: '600',
    fontSize: 15,
    flex: 1,
    color: COLORS.text.primary,
  },
  editSettingLabel: {
    fontWeight: '600',
    fontSize: 15,
    flex: 1,
    color: ink.primary,
    fontFamily: fonts.sans,
  },
  settingValue: {
    fontSize: 15,
    color: ink.soft,
    fontFamily: fonts.sans,
  },
  settingInput: {
    borderWidth: 1,
    borderColor: '#ccc',
    padding: SPACING.sm,
    borderRadius: BORDER_RADIUS.xs,
    flex: 1,
    marginLeft: SPACING.md,
  },
  settingFieldFlex: {
    flex: 1,
    marginLeft: SPACING.md,
  },

  // ===== Icon Selector =====
  currentIcon: {
    fontSize: 24,
  },
  iconButtonText: {
    color: COLORS.secondary,
    fontWeight: '500',
  },

  // ===== Energy Container =====
  energyContainer: {
    marginVertical: SPACING.md,
  },
  energyHeader: {
    flexDirection: 'row',
    justifyContent: JUSTIFY_SPACE_BETWEEN,
    paddingHorizontal: SPACING.xxl,
    marginBottom: SPACING.sm,
  },
  energyHeaderText: {
    fontWeight: '600',
    fontSize: 15,
    width: 60,
    textAlign: 'center',
    color: COLORS.text.primary,
  },
  energyRow: {
    flexDirection: 'row',
    justifyContent: JUSTIFY_SPACE_BETWEEN,
    paddingHorizontal: SPACING.xxl,
  },
  energyInput: {
    borderWidth: 1,
    borderColor: '#ccc',
    width: 60,
    textAlign: 'center',
    padding: SPACING.sm,
    borderRadius: BORDER_RADIUS.xs,
  },
  netEnergyValue: {
    width: 60,
    textAlign: 'center',
    padding: SPACING.sm,
    fontSize: 16,
    fontWeight: 'bold',
    color: COLORS.text.primary,
  },
  validationNote: {
    alignItems: 'center',
    marginTop: SPACING.sm,
  },
  validationText: {
    fontSize: 12,
    color: COLORS.text.secondary,
    fontStyle: 'italic',
  },

  // ===== Time Input =====
  timeInputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  timeButton: {
    backgroundColor: surface.sunken,
    borderWidth: 1,
    borderColor: surface.hairline,
    minHeight: touchTarget.minimum,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.xs,
    justifyContent: 'center',
  },
  timeButtonText: {
    color: ink.primary,
    fontFamily: fonts.sans,
    fontSize: 16,
  },
  addTimeButton: {
    backgroundColor: accent.primary,
    width: touchTarget.minimum,
    height: touchTarget.minimum,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: SPACING.sm,
  },
  addTimeButtonText: {
    color: accent.onPrimary,
    fontSize: 20,
    fontWeight: 'bold',
  },
  timesList: {
    marginTop: SPACING.md,
  },
  timeItem: {
    flexDirection: 'row',
    justifyContent: JUSTIFY_SPACE_BETWEEN,
    alignItems: 'center',
    backgroundColor: surface.sunken,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.xs,
    marginVertical: SPACING.xs,
  },
  timeText: {
    fontSize: 16,
    color: ink.primary,
    fontFamily: fonts.sans,
  },
  removeTimeButton: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: COLORS.destructive.background,
    justifyContent: 'center',
    alignItems: 'center',
  },
  removeTimeButtonText: {
    color: COLORS.destructive.text,
    fontSize: 16,
    fontWeight: 'bold',
  },

  // ===== Days Button =====
  daysButton: {
    backgroundColor: surface.sunken,
    borderWidth: 1,
    borderColor: surface.hairline,
    minHeight: touchTarget.minimum,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.xs,
    flex: 1,
    marginLeft: SPACING.md,
    justifyContent: 'center',
  },
  daysButtonText: {
    color: ink.primary,
    fontFamily: fonts.sans,
    fontSize: 14,
  },
  daysPicker: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: SPACING.md,
    justifyContent: JUSTIFY_SPACE_BETWEEN,
  },

  // ===== Button Groups =====
  buttonGroup: {
    marginVertical: SPACING.lg,
  },
  deleteButton: {
    backgroundColor: surface.raised,
    borderWidth: 1,
    borderColor: COLORS.destructive.border,
    minHeight: touchTarget.minimum,
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.lg,
    borderRadius: BORDER_RADIUS.xs,
    marginTop: SPACING.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteButtonText: {
    color: COLORS.destructive.text,
    fontSize: 16,
    fontWeight: 'bold',
  },

  // ===== Frequency Button =====
  frequencyButton: {
    backgroundColor: surface.sunken,
    borderWidth: 1,
    borderColor: surface.hairline,
    minHeight: touchTarget.minimum,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.xs,
    flex: 1,
    marginLeft: SPACING.md,
    justifyContent: 'center',
  },
  frequencyButtonText: {
    color: ink.primary,
    fontFamily: fonts.sans,
    fontSize: 16,
  },

  // ===== Stats Modal =====
  statsModalContent: {
    width: '90%',
    maxHeight: '80%',
    backgroundColor: COLORS.background.card,
    borderRadius: BORDER_RADIUS.xl,
    padding: SPACING.lg,
    borderTopWidth: 5,
    ...SHADOWS.large,
  },
  tabContainer: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginVertical: SPACING.md,
  },
  tabButton: {
    flex: 1,
    paddingVertical: SPACING.md,
    alignItems: 'center',
    borderBottomWidth: 2,
    borderColor: 'transparent',
  },
  activeTab: {
    borderColor: COLORS.success,
  },
  tabButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.text.primary,
  },
  statsContainer: {
    padding: SPACING.md,
  },
  calendarContainer: {
    marginVertical: SPACING.md,
  },
  statsInfoContainer: {
    marginTop: SPACING.lg,
    backgroundColor: surface.canvas,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.md,
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: JUSTIFY_SPACE_BETWEEN,
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderColor: '#eee',
  },
  statLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: COLORS.text.primary,
  },
  statValue: {
    fontSize: 15,
    color: COLORS.text.secondary,
  },
  chartContainer: {
    marginVertical: SPACING.lg,
    alignItems: 'center',
  },
  chartTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: SPACING.lg,
    textAlign: 'center',
    color: COLORS.text.primary,
  },
  chart: {
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.xs,
  },

  // ===== Reorder Modal =====
  reorderModalContent: {
    width: '90%',
    height: '85%',
    backgroundColor: surface.raised,
    borderRadius: BORDER_RADIUS.xl,
    padding: SPACING.lg,
    ...surfaceShadow.raised,
  },
  datePickerContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: SPACING.lg,
  },
  datePickerLabel: {
    fontSize: 16,
    fontWeight: '600',
    marginRight: SPACING.md,
    color: ink.primary,
    fontFamily: fonts.sans,
  },
  datePickerButton: {
    backgroundColor: surface.sunken,
    borderWidth: 1,
    borderColor: surface.hairline,
    minHeight: touchTarget.minimum,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.xs,
    justifyContent: 'center',
  },
  datePickerButtonText: {
    color: ink.primary,
    fontFamily: fonts.sans,
    fontSize: 16,
  },
  reorderInstructions: {
    fontSize: 14,
    color: ink.muted,
    marginBottom: SPACING.lg,
    textAlign: 'center',
    fontStyle: 'italic',
  },
  reorderList: {
    flex: 1,
    marginVertical: SPACING.md,
  },
  reorderItem: {
    padding: SPACING.lg,
    borderBottomWidth: 1,
    borderColor: surface.hairline,
    backgroundColor: surface.raised,
  },
  reorderItemActive: {
    backgroundColor: surface.sunken,
    ...surfaceShadow.card,
  },
  reorderItemContent: {
    flexDirection: 'row',
    justifyContent: JUSTIFY_SPACE_BETWEEN,
    alignItems: 'center',
  },
  reorderItemText: {
    fontSize: 16,
    fontWeight: '500',
    color: ink.primary,
    fontFamily: fonts.sans,
  },
  reorderItemDate: {
    fontSize: 14,
    color: ink.soft,
  },

  // ===== Missed Days Modal =====
  missedDaysContent: {
    width: '90%',
    backgroundColor: COLORS.background.card,
    borderRadius: BORDER_RADIUS.xl,
    padding: SPACING.xl,
    alignItems: 'center',
    ...SHADOWS.large,
  },
  missedDaysTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: SPACING.md,
    textAlign: 'center',
    color: COLORS.text.primary,
  },
  missedDaysSubtitle: {
    fontSize: 16,
    marginBottom: SPACING.md,
    textAlign: 'center',
    color: COLORS.text.secondary,
  },
  missedDaysQuestion: {
    fontSize: 16,
    marginBottom: SPACING.xl,
    textAlign: 'center',
    fontWeight: '500',
    color: COLORS.text.primary,
  },
  missedDaysButtons: {
    flexDirection: 'column',
    width: '100%',
  },
  missedDaysButton: {
    marginVertical: SPACING.xs,
    paddingVertical: SPACING.md,
    alignItems: 'center',
    borderRadius: BORDER_RADIUS.xs,
    ...SHADOWS.small,
  },
  missedDaysButtonText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: COLORS.text.light,
  },
  yesButton: {
    backgroundColor: COLORS.success,
  },
  resetButton: {
    backgroundColor: COLORS.warning,
  },
  cancelButton: {
    backgroundColor: COLORS.neutral,
  },

  // ===== Onboarding Modal =====
  onboardingModalContent: {
    width: '95%',
    backgroundColor: COLORS.background.card,
    borderRadius: BORDER_RADIUS.xl,
    padding: SPACING.xl,
    height: '90%',
    ...SHADOWS.large,
  },
  reorderListWindow: {
    maxHeight: '92%',
    flexGrow: 1,
    minHeight: 0,
    ...(Platform.OS === 'web'
      ? {
          overflowY: 'auto',
          overscrollBehavior: 'contain',
        }
      : {}),
  },
  modalClose: {
    position: 'absolute',
    top: SPACING.sm,
    right: SPACING.sm,
    zIndex: 1,
  },
  modalCloseText: {
    fontSize: 24,
    color: COLORS.text.secondary,
  },
  discardModal: {
    width: '80%',
    backgroundColor: COLORS.background.card,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.lg,
    ...SHADOWS.large,
  },
  discardTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: COLORS.text.primary,
    marginBottom: SPACING.sm,
  },
  discardMessage: {
    fontSize: 16,
    color: COLORS.text.secondary,
    marginBottom: SPACING.lg,
  },
  discardActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  discardButton: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    marginLeft: SPACING.md,
  },
  discardButtonText: {
    color: COLORS.text.primary,
    fontSize: 16,
  },
  discardExitText: {
    color: COLORS.danger,
    fontSize: 16,
  },
  onboardingStep: {
    flex: 1,
    minHeight: 0,
  },
  onboardingTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: SPACING.sm,
    textAlign: 'center',
    color: COLORS.text.primary,
  },
  onboardingSubtitle: {
    fontSize: 16,
    marginBottom: SPACING.xl,
    textAlign: 'center',
    color: COLORS.text.secondary,
  },
  addHabitContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: SPACING.lg,
  },
  addHabitInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ccc',
    padding: SPACING.md,
    borderRadius: BORDER_RADIUS.xs,
    fontSize: 16,
  },
  addHabitButton: {
    marginLeft: SPACING.md,
    backgroundColor: COLORS.success,
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
    ...SHADOWS.medium,
  },
  addHabitButtonText: {
    fontSize: 24,
    color: COLORS.text.light,
    fontWeight: 'bold',
  },
  habitDragInfo: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  dragHandle: {
    width: 20,
    alignItems: 'center',
    marginRight: SPACING.md,
  },
  dragHandleText: {
    fontSize: 20,
    color: COLORS.text.secondary,
  },
  habitListItemDate: {
    fontSize: 14,
    color: COLORS.text.secondary,
    marginRight: SPACING.md,
    minWidth: 80,
  },
  habitEnergyInfo: {
    marginTop: SPACING.sm,
    paddingLeft: 90,
  },
  habitEnergyText: {
    fontSize: 14,
    color: COLORS.text.secondary,
  },
  iconEditButton: {
    marginLeft: SPACING.md,
    padding: SPACING.xs,
  },
  iconEditButtonText: {
    fontSize: 18,
  },

  // ===== Energy Rating =====
  energyTile: {
    backgroundColor: surface.canvas,
    padding: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
    marginBottom: SPACING.sm,
    ...SHADOWS.small,
  },
  energyTileName: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: SPACING.xs,
    color: COLORS.text.primary,
  },
  energySliderRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  energySliderContainer: {
    flex: 1,
    marginRight: SPACING.sm,
    backgroundColor: COLORS.background.accent,
    borderRadius: BORDER_RADIUS.sm,
    paddingHorizontal: SPACING.sm,
    justifyContent: 'center',
    ...SHADOWS.small,
  },
  energySlider: {
    width: '100%',
    height: SPACING.lg,
  },
  energySliderWeb: {
    cursor: 'ew-resize',
  } as unknown as ViewStyle,
  sliderValue: {
    fontSize: 16,
    fontWeight: '600',
    width: 24,
    textAlign: 'center',
    color: COLORS.text.primary,
  },

  // ===== Start Date =====
  startDateContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: SPACING.lg,
    padding: SPACING.md,
    backgroundColor: COLORS.background.accent,
    borderRadius: BORDER_RADIUS.md,
  },
  startDateLabel: {
    fontSize: 16,
    fontWeight: '600',
    marginRight: SPACING.md,
    color: COLORS.text.primary,
  },

  // ===== Habits List =====
  habitsList: {
    flex: 1,
    marginVertical: SPACING.lg,
  },
  habitsListContent: {
    paddingBottom: SPACING.xxl * 2,
  },
  habitListItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: JUSTIFY_SPACE_BETWEEN,
    backgroundColor: surface.canvas,
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.lg,
    borderRadius: BORDER_RADIUS.lg,
    marginVertical: SPACING.sm,
    borderWidth: 1,
    borderColor: '#ddd',
    ...SHADOWS.small,
  },
  habitListItemText: {
    fontSize: 16,
    fontWeight: '500',
    color: COLORS.text.primary,
    flexShrink: 1,
  },

  habitChipContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingBottom: SPACING.lg,
  },
  habitChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: surface.canvas,
    borderRadius: BORDER_RADIUS.lg,
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.md,
    margin: SPACING.xs,
    ...SHADOWS.small,
  },
  habitChipText: {
    fontSize: 14,
    color: COLORS.text.primary,
  },
  removeHabitChip: {
    marginLeft: SPACING.xs,
  },
  removeHabitChipText: {
    fontSize: 16,
    color: COLORS.danger,
  },
  habitError: {
    color: COLORS.danger,
    textAlign: 'center',
  },
  bottomContainer: {
    marginTop: 'auto',
    alignItems: 'center',
  },
  habitCount: {
    textAlign: 'center',
    color: COLORS.text.secondary,
    marginBottom: SPACING.md,
  },

  // ===== Onboarding Buttons =====
  onboardingContinueButton: {
    backgroundColor: COLORS.secondary,
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.xl,
    borderRadius: BORDER_RADIUS.xs,
    marginVertical: SPACING.lg,
    alignItems: 'center',
    ...SHADOWS.medium,
  },
  onboardingContinueButtonText: {
    color: COLORS.text.light,
    fontSize: 16,
    fontWeight: 'bold',
  },
  onboardingFooter: {
    flexDirection: 'row',
    justifyContent: JUSTIFY_SPACE_BETWEEN,
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderTopWidth: 1,
    borderColor: '#eee',
    backgroundColor: COLORS.background.card,
  },
  onboardingBackButton: {
    flex: 1,
    marginRight: SPACING.sm,
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.lg,
    borderRadius: BORDER_RADIUS.xs,
    alignItems: 'center',
    backgroundColor: COLORS.background.accent,
  },
  onboardingBackButtonText: {
    color: COLORS.text.primary,
    fontSize: 16,
    fontWeight: 'bold',
  },
  footerContinue: {
    flex: 1,
    marginLeft: SPACING.sm,
  },
  disabledButton: {
    opacity: 0.5,
  },

  // ===== Energy Scaffolding Button =====
  energyScaffoldingContainer: {
    position: 'absolute',
    bottom: 20,
    left: 20,
    right: 20,
    flexDirection: 'row',
    alignItems: 'center',
  },
  energyScaffoldingButton: {
    flex: 1,
    backgroundColor: COLORS.primary,
    paddingVertical: SPACING.md,
    borderRadius: BORDER_RADIUS.xxl,
    alignItems: 'center',
    marginRight: SPACING.sm,
    ...SHADOWS.medium,
  },
  archiveEnergyButton: {
    backgroundColor: COLORS.background.accent,
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.xxl,
    alignItems: 'center',
    ...SHADOWS.small,
  },
  energyScaffoldingButtonText: {
    color: COLORS.text.light,
    fontSize: 16,
    fontWeight: 'bold',
  },
  archivedMessage: {
    textAlign: 'center',
    marginTop: SPACING.md,
    color: COLORS.text.tertiary,
  },

  // ===== Pagination =====
  paginationBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  paginationButton: {
    backgroundColor: COLORS.secondary,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    borderRadius: BORDER_RADIUS.xs,
    ...SHADOWS.small,
  },
  paginationButtonText: {
    color: COLORS.text.light,
    fontWeight: '600',
  },
  paginationLabel: {
    color: COLORS.text.primary,
    fontWeight: '600',
  },
});

export default styles;
