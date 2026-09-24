import { StyleSheet } from 'react-native';

import {
  accent,
  BORDER_RADIUS,
  colors,
  ink,
  rhythm,
  SPACING,
  surface,
  touchTarget,
  uiType,
} from '@/design/tokens';

/** The shared look of the composer's exclusive choices (category and impact). */
export const optionStyles = StyleSheet.create({
  group: { gap: SPACING.sm },
  section: { marginBottom: rhythm.blockGap },
  option: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    borderColor: surface.hairline,
    backgroundColor: surface.raised,
  },
  optionSelected: { borderColor: accent.primary, backgroundColor: surface.sunken },
  label: { color: ink.primary, fontSize: uiType.button.fontSize },
  labelSelected: { color: accent.strong, fontWeight: uiType.button.fontWeight },
  prompt: { color: ink.primary, marginBottom: rhythm.blockGap },
  error: { color: colors.destructive.text, marginTop: SPACING.xs },
  description: { color: ink.soft, marginTop: SPACING.xs, marginLeft: SPACING.lg },
});
