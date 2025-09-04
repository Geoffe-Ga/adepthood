import { StyleSheet } from 'react-native';

//------------------
// Theme Configuration (easier to maintain and change)
//------------------

const COLORS = {
  // Primary palette
  primary: '#1a1910',
  secondary: '#413d2f',
  success: '#535c46',
  warning: '#6c6b63',
  danger: '#7b3f30',
  neutral: '#8c8c8c',

  // Background shades
  background: {
    primary: '#f8f8f8', // Main app background
    card: '#ffffff', // Card backgrounds
    accent: '#f0f0f0', // Accent backgrounds
  },

  // Text shades
  text: {
    primary: '#333333', // Main text color
    secondary: '#666666', // Secondary text color
    tertiary: '#999999', // Tertiary text color
    light: '#ffffff', // Light text (on dark backgrounds)
  },

  // Mystical gradients and effects
  mystical: {
    glowLight: 'rgba(255, 255, 255, 0.2)',
    glowPurple: 'rgba(103, 58, 183, 0.15)',
    overlay: 'rgba(0, 0, 0, 0.5)',
    transparentLight: 'rgba(255, 255, 255, 0.7)',
  },
};

// Common style patterns
const SHADOWS = {
  small: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  medium: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 3,
    elevation: 3,
  },
  large: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 5,
  },
  glow: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 5,
  },
};

const SPACING = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 30,
};

const BORDER_RADIUS = {
  xs: 2,
  sm: 4,
  md: 8,
  lg: 12,
  xl: 15,
  xxl: 30,
  circle: 9999,
};

// Device dimensions (for responsive layouts)

//------------------
// Styles (modernized mystical minimalist style)
//------------------

// Group styles logically by component/feature
export const styles = StyleSheet.create({
  // ===== Layout containers =====
  container: {
    flex: 1,
    backgroundColor: COLORS.background.primary,
    padding: SPACING.md,
  },
  habitsGrid: {
    justifyContent: 'space-between',
  },

  // ===== Habit Tiles =====
  tile: {
    flex: 1,
    margin: SPACING.xs,
    padding: SPACING.lg,
    borderRadius: BORDER_RADIUS.lg,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    ...SHADOWS.medium,
  },
  glowEffect: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: BORDER_RADIUS.lg,
    opacity: 0.2,
    backgroundColor: COLORS.mystical.glowLight,
  },
  icon: {
    fontSize: 40,
    marginTop: SPACING.sm,
    marginBottom: SPACING.xs,
  },
  iconLarge: {
    fontSize: 24,
  },
  name: {
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
    color: COLORS.text.primary,
  },
  menuShadow: {
    shadowColor: SHADOWS.medium.shadowColor,
    shadowOffset: SHADOWS.medium.shadowOffset,
    shadowOpacity: SHADOWS.medium.shadowOpacity,
    shadowRadius: SHADOWS.medium.shadowRadius,
    elevation: 2,
  },

  // ===== Streaks =====
  streakContainer: {
    marginTop: SPACING.xs,
    backgroundColor: COLORS.mystical.transparentLight,
    borderRadius: BORDER_RADIUS.md,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
  },
  streakText: {
    fontSize: 14,
    fontWeight: 'bold',
    color: COLORS.text.primary,
  },
  streakBadge: {
    fontSize: 16,
    backgroundColor: COLORS.background.accent,
    borderRadius: BORDER_RADIUS.md,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    marginHorizontal: SPACING.md,
  },

  // ===== Progress Bars =====
  progressBarContainer: {
    width: '100%',
    height: 16,
    backgroundColor: COLORS.background.accent,
    borderRadius: BORDER_RADIUS.xs,
    marginTop: SPACING.xs,
    overflow: 'hidden',
    position: 'relative',
  },
  progressBar: {
    height: '100%',
    width: '100%',
    backgroundColor: 'transparent', // Changed to transparent
    borderRadius: BORDER_RADIUS.md,
    position: 'relative',
  },
  progressBarFill: {
    height: '100%',
    position: 'absolute',
    left: 0,
    top: 0,
    borderRadius: BORDER_RADIUS.md,
  },
  progressBarOverlay: {
    height: '100%',
    position: 'absolute',
    top: 0,
    borderRadius: BORDER_RADIUS.md,
  },
  goalMarker: {
    position: 'absolute',
    height: '100%',
    width: SPACING.sm,
    backgroundColor: COLORS.mystical.overlay,
    zIndex: 1,
  },
  incrementMarker: {
    position: 'absolute',
    height: '70%',
    width: SPACING.xs,
    top: '15%',
    backgroundColor: COLORS.mystical.overlay,
    zIndex: 1,
  },
  goalIncrementMarker: {
    position: 'absolute',
    height: '70%',
    width: SPACING.xs,
    top: '15%',
    backgroundColor: COLORS.mystical.overlay,
    zIndex: 1,
  },

  // ===== Stats Button and Tooltips =====
  statsButton: {
    position: 'absolute',
    top: SPACING.xs,
    right: SPACING.xs,
    padding: SPACING.xs,
    zIndex: 2,
  },
  statsButtonText: {
    fontSize: 20,
  },
  tooltip: {
    position: 'absolute',
    top: -40,
    backgroundColor: COLORS.mystical.overlay,
    padding: SPACING.sm,
    borderRadius: BORDER_RADIUS.sm,
    zIndex: 10,
  },
  tooltipText: {
    color: COLORS.text.light,
    fontSize: 12,
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
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderColor: '#eee',
    paddingBottom: SPACING.md,
    marginBottom: SPACING.md,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    flex: 1,
    color: COLORS.text.primary,
  },
  closeButton: {
    padding: SPACING.xs,
  },
  closeButtonText: {
    fontSize: 28,
    lineHeight: 28,
    fontWeight: '300',
    color: COLORS.text.secondary,
  },

  // ===== Goal Items =====
  goalsContainer: {
    marginVertical: SPACING.md,
    flex: 1,
  },
  goalItem: {
    marginVertical: SPACING.sm,
    padding: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    ...SHADOWS.small,
  },
  goalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: SPACING.xs,
  },
  goalTier: {
    fontSize: 14,
    fontWeight: 'bold',
    color: COLORS.text.primary,
  },
  saveButton: {
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    backgroundColor: COLORS.success,
    borderRadius: BORDER_RADIUS.xs,
  },
  saveButtonText: {
    color: COLORS.text.light,
    fontWeight: '600',
  },
  goalTitle: {
    fontSize: 16,
    marginVertical: SPACING.xs,
    fontWeight: '500',
    color: COLORS.text.primary,
  },
  goalTitleInput: {
    fontSize: 16,
    marginVertical: SPACING.xs,
    borderBottomWidth: 1,
    borderColor: '#ccc',
    padding: SPACING.xs,
  },
  goalDetailsContainer: {
    marginVertical: SPACING.xs,
  },
  goalDetails: {
    fontSize: 14,
    color: COLORS.text.secondary,
  },

  // ===== Edit Forms =====
  editRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: SPACING.xs,
    flexWrap: 'wrap',
  },
  editLabel: {
    width: 60,
    fontSize: 14,
    color: COLORS.text.primary,
  },
  editInput: {
    borderWidth: 1,
    borderColor: '#ccc',
    padding: SPACING.sm,
    marginHorizontal: SPACING.xs,
    flex: 1,
    borderRadius: BORDER_RADIUS.xs,
  },
  unitDropdownButton: {
    backgroundColor: COLORS.background.accent,
    padding: SPACING.sm,
    borderRadius: BORDER_RADIUS.xs,
    minWidth: 100,
    alignItems: 'center',
    marginLeft: SPACING.xs,
  },
  dropdown: {
    position: 'absolute',
    top: 30,
    right: 0,
    backgroundColor: COLORS.background.card,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: BORDER_RADIUS.xs,
    maxHeight: 150,
    width: 150,
    zIndex: 999,
    ...SHADOWS.medium,
  },
  dropdownItem: {
    padding: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },

  // ===== Days Selector =====
  daysSelectorButton: {
    backgroundColor: COLORS.background.accent,
    padding: SPACING.sm,
    borderRadius: BORDER_RADIUS.xs,
    flex: 1,
    marginLeft: SPACING.xs,
  },
  daysSelector: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: SPACING.xs,
    marginLeft: 60,
  },
  dayOption: {
    backgroundColor: COLORS.background.accent,
    padding: SPACING.sm,
    borderRadius: BORDER_RADIUS.xs,
    margin: 2,
  },
  selectedDayOption: {
    backgroundColor: '#aed581',
  },
  dayOptionText: {
    fontSize: 12,
    color: COLORS.text.primary,
  },

  // ===== Toggle Buttons =====
  toggleButton: {
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.xs,
    marginHorizontal: 3,
    marginTop: SPACING.xs,
  },
  toggleText: {
    color: COLORS.text.light,
    fontWeight: '500',
  },

  // ===== Goal Progress =====
  goalProgressContainer: {
    marginTop: SPACING.sm,
  },

  goalProgressText: {
    marginTop: 3,
    fontSize: 12,
    color: COLORS.text.tertiary,
    textAlign: 'right',
  },

  // ===== Action Buttons =====
  actionButtons: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: SPACING.lg,
    paddingTop: SPACING.md,
    borderTopWidth: 1,
    borderColor: '#eee',
  },
  logUnitContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  // Updated log unit button with better visual feedback
  logUnitButtonText: {
    color: COLORS.text.light,
    fontWeight: '600',
    fontSize: 15,
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
  logUnitButton: {
    backgroundColor: COLORS.success,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.xs,
    ...SHADOWS.small,
  },
  editButton: {
    backgroundColor: COLORS.secondary,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.xs,
    ...SHADOWS.small,
  },
  editButtonText: {
    color: COLORS.text.light,
    fontWeight: '600',
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
  settingsContainer: {
    marginTop: SPACING.md,
  },
  settingGroup: {
    marginVertical: SPACING.md,
    borderBottomWidth: 1,
    borderColor: '#eee',
    paddingBottom: SPACING.md,
  },
  settingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginVertical: SPACING.sm,
  },
  settingLabel: {
    fontWeight: '600',
    fontSize: 15,
    flex: 1,
    color: COLORS.text.primary,
  },
  settingValue: {
    fontSize: 15,
    color: COLORS.text.secondary,
  },
  settingInput: {
    borderWidth: 1,
    borderColor: '#ccc',
    padding: SPACING.sm,
    borderRadius: BORDER_RADIUS.xs,
    flex: 1,
    marginLeft: SPACING.md,
  },

  // ===== Icon Selector =====
  iconSelectorButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.background.accent,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.xs,
    ...SHADOWS.small,
  },
  currentIcon: {
    fontSize: 24,
  },
  iconButtonText: {
    color: COLORS.secondary,
    fontWeight: '500',
  },
  emojiSelectorContainer: {
    height: 200,
    marginVertical: SPACING.md,
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: BORDER_RADIUS.md,
    overflow: 'hidden',
    backgroundColor: '#fff',
  },

  // ===== Reorder Button =====
  reorderButton: {
    backgroundColor: COLORS.primary,
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.lg,
    borderRadius: BORDER_RADIUS.xs,
    marginVertical: SPACING.md,
    alignItems: 'center',
    ...SHADOWS.medium,
  },
  reorderButtonText: {
    color: COLORS.text.light,
    fontWeight: '600',
    fontSize: 16,
  },

  // ===== Energy Container =====
  energyContainer: {
    marginVertical: SPACING.md,
  },
  energyHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
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
    justifyContent: 'space-between',
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
    backgroundColor: COLORS.secondary,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.xs,
    ...SHADOWS.small,
  },
  timeButtonText: {
    color: COLORS.text.light,
    fontSize: 16,
  },
  addTimeButton: {
    backgroundColor: COLORS.success,
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: SPACING.sm,
    ...SHADOWS.small,
  },
  addTimeButtonText: {
    color: COLORS.text.light,
    fontSize: 20,
    fontWeight: 'bold',
  },
  timesList: {
    marginTop: SPACING.md,
  },
  timeItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: COLORS.background.accent,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.xs,
    marginVertical: SPACING.xs,
  },
  timeText: {
    fontSize: 16,
    color: COLORS.text.primary,
  },
  removeTimeButton: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: COLORS.danger,
    justifyContent: 'center',
    alignItems: 'center',
  },
  removeTimeButtonText: {
    color: COLORS.text.light,
    fontSize: 16,
    fontWeight: 'bold',
  },

  // ===== Days Button =====
  daysButton: {
    backgroundColor: COLORS.secondary,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.xs,
    flex: 1,
    marginLeft: SPACING.md,
    ...SHADOWS.small,
  },
  daysButtonText: {
    color: COLORS.text.light,
    fontSize: 14,
  },
  daysPicker: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: SPACING.md,
    justifyContent: 'space-between',
  },

  // ===== Button Groups =====
  buttonGroup: {
    marginVertical: SPACING.lg,
  },
  deleteButton: {
    backgroundColor: COLORS.danger,
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.lg,
    borderRadius: BORDER_RADIUS.xs,
    marginTop: SPACING.md,
    alignItems: 'center',
    ...SHADOWS.medium,
  },
  deleteButtonText: {
    color: COLORS.text.light,
    fontSize: 16,
    fontWeight: 'bold',
  },

  // ===== Frequency Button =====
  frequencyButton: {
    backgroundColor: COLORS.secondary,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.xs,
    flex: 1,
    marginLeft: SPACING.md,
    ...SHADOWS.small,
  },
  frequencyButtonText: {
    color: COLORS.text.light,
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
    backgroundColor: COLORS.background.primary,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.md,
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
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
    backgroundColor: COLORS.background.card,
    borderRadius: BORDER_RADIUS.xl,
    padding: SPACING.lg,
    ...SHADOWS.large,
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
    color: COLORS.text.primary,
  },
  datePickerButton: {
    backgroundColor: COLORS.secondary,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.xs,
    ...SHADOWS.small,
  },
  datePickerButtonText: {
    color: COLORS.text.light,
    fontSize: 16,
  },
  reorderInstructions: {
    fontSize: 14,
    color: COLORS.text.secondary,
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
    borderColor: '#eee',
    backgroundColor: COLORS.background.card,
  },
  reorderItemActive: {
    backgroundColor: COLORS.background.accent,
    ...SHADOWS.medium,
  },
  reorderItemContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  reorderItemText: {
    fontSize: 16,
    fontWeight: '500',
    color: COLORS.text.primary,
  },
  reorderItemDate: {
    fontSize: 14,
    color: COLORS.text.secondary,
  },
  saveOrderButton: {
    backgroundColor: COLORS.success,
    paddingVertical: SPACING.md,
    borderRadius: BORDER_RADIUS.xs,
    marginTop: SPACING.lg,
    alignItems: 'center',
    ...SHADOWS.medium,
  },
  saveOrderButtonText: {
    color: COLORS.text.light,
    fontSize: 16,
    fontWeight: 'bold',
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
    maxHeight: '90%',
    overflow: 'hidden',
    ...SHADOWS.large,
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
  habitList: {
    maxHeight: 200,
    marginVertical: SPACING.lg,
  },
  habitDragInfo: {
    flexDirection: 'row',
    alignItems: 'center',
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
  dragHandle: {
    paddingHorizontal: SPACING.sm,
    marginRight: SPACING.md,
  },
  dragHandleText: {
    fontSize: 18,
    color: COLORS.text.secondary,
  },

  // ===== Energy Rating =====
  energyRatingItem: {
    backgroundColor: COLORS.background.primary,
    padding: SPACING.lg,
    borderRadius: BORDER_RADIUS.md,
    marginVertical: SPACING.sm,
    ...SHADOWS.small,
  },
  energyRatingName: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: SPACING.md,
    color: COLORS.text.primary,
  },
  energyRatingDetails: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  energySliders: {
    flex: 3,
  },
  energySliderLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.text.primary,
    marginRight: SPACING.md,
  },
  sliderContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.md,
    marginTop: SPACING.xs,
    marginBottom: SPACING.sm,
  },
  sliderButton: {
    width: 32,
    height: 32,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: COLORS.background.accent,
    justifyContent: 'center',
    alignItems: 'center',
    ...SHADOWS.small,
  },
  sliderButtonText: {
    fontSize: 20,
    fontWeight: 'bold',
    color: COLORS.text.primary,
  },
  sliderValue: {
    fontSize: 16,
    fontWeight: '600',
    minWidth: 24,
    textAlign: 'center',
    color: COLORS.text.primary,
  },
  netEnergyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.background.accent,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.md,
    marginLeft: SPACING.md,
  },
  netEnergyLabel: {
    fontSize: 14,
    fontWeight: 'bold',
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
  startDateButton: {
    backgroundColor: COLORS.secondary,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.xs,
    ...SHADOWS.small,
  },
  startDateButtonText: {
    color: COLORS.text.light,
    fontSize: 16,
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
    justifyContent: 'space-between',
    backgroundColor: COLORS.background.primary,
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
  removeHabitButton: {
    marginLeft: SPACING.md,
    backgroundColor: COLORS.danger,
    borderRadius: 20,
    width: 28,
    height: 28,
    justifyContent: 'center',
    alignItems: 'center',
    ...SHADOWS.small,
  },
  removeHabitButtonText: {
    color: COLORS.text.light,
    fontWeight: 'bold',
    fontSize: 16,
    lineHeight: 16,
  },

  // ===== Emoji Picker =====
  emojiPickerModal: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#fff',
    height: 280,
    borderTopLeftRadius: BORDER_RADIUS.xl,
    borderTopRightRadius: BORDER_RADIUS.xl,
    ...SHADOWS.large,
    zIndex: 1000,
  },
  emojiPickerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: SPACING.lg,
    borderBottomWidth: 1,
    borderColor: '#eee',
  },
  emojiPickerTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: COLORS.text.primary,
  },
  closeEmojiPicker: {
    padding: SPACING.xs,
  },
  closeEmojiPickerText: {
    fontSize: 24,
    fontWeight: '300',
    color: COLORS.text.secondary,
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

  // ===== Overflow Menu =====
  topBar: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginBottom: SPACING.sm,
    zIndex: 1000,
  },
  overflowMenuContainer: {
    zIndex: 1001,
  },
  habitSummary: {
    backgroundColor: 'rgba(0, 0, 0, 0.05)',
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
  },
  habitSummaryText: {
    fontSize: 14,
    marginBottom: 4,
    color: '#333',
  },

  // Goal header toggle styles
  goalHeaderToggle: {
    backgroundColor: 'rgba(0, 0, 0, 0.1)',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 6,
    marginVertical: 4,
  },
  goalHeaderToggleText: {
    fontWeight: '600',
    fontSize: 13,
    color: '#444',
  },

  // Enhanced progress bar styles
  goalProgressBar: {
    height: 12,
    backgroundColor: COLORS.background.primary,
    borderRadius: 6,
    overflow: 'hidden',
    position: 'relative',
    marginVertical: 8,
    borderWidth: 1,
    borderColor: COLORS.mystical.overlay,
  },
  goalProgressFill: {
    height: '100%',
    position: 'absolute',
    left: 0,
    top: 0,
    borderRadius: SPACING.md,
  },

  // Achievement indicator styles
  achievementBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    backgroundColor: 'rgba(255, 215, 0, 0.8)',
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  achievementBadgeText: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#333',
  },
  menuIcon: {
    position: 'absolute',
    top: 8,
    right: 8,
    zIndex: 5,
    padding: 6,
  },
  desktopActions: {
    position: 'absolute',
    top: 8,
    right: 8,
    flexDirection: 'row',
    zIndex: 5,
  },
  mobileMenu: {
    position: 'absolute',
    top: 36,
    right: 8,
    backgroundColor: '#fff',
    borderRadius: 8,
    padding: 8,
    zIndex: 1002,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 10,
  },
  contentContainer: {
    width: '100%',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 16,
  },
  streak: {
    marginTop: 4,
    fontSize: 12,
    color: '#555',
    fontWeight: '500',
  },
  progressBarWrapper: {
    width: '100%',
    paddingHorizontal: 8,
    marginTop: 12,
  },
  progressBarBackground: {
    width: '100%',
    height: 12,
    backgroundColor: '#eee',
    borderRadius: 6,
    overflow: 'hidden',
    position: 'relative',
  },
  markerTooltip: {
    position: 'absolute',
    top: -40,
    transform: [{ translateX: -50 }],
    backgroundColor: 'rgba(0,0,0,0.8)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    zIndex: 10,
    minWidth: 100,
    alignItems: 'center',
  },
});

export default styles;
