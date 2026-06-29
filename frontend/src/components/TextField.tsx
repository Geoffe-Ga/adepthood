import React, { useState } from 'react';
import { StyleSheet, TextInput } from 'react-native';
import type { NativeSyntheticEvent, TextInputFocusEventData, TextInputProps } from 'react-native';

import {
  accent,
  BORDER_RADIUS,
  colors,
  ink,
  SPACING,
  surface,
  touchTarget,
  uiType,
} from '@/design/tokens';

interface TextFieldProps extends TextInputProps {
  /** Recessed (sunken) variant using the warm bevel tokens. */
  recessed?: boolean;
}

/**
 * Shared text input in the warm "Candle & Ink" language (#801): warm ground,
 * hairline border, ink text, ink.muted placeholder, terracotta focus border.
 * Forwards all standard TextInput props (value, onChangeText, secureTextEntry,
 * testID, …) and composes focus/blur so the focus ring works alongside callers.
 */
export function TextField({
  recessed = false,
  style,
  onFocus,
  onBlur,
  ...rest
}: TextFieldProps): React.JSX.Element {
  const [focused, setFocused] = useState(false);
  const handleFocus = (event: NativeSyntheticEvent<TextInputFocusEventData>): void => {
    setFocused(true);
    onFocus?.(event);
  };
  const handleBlur = (event: NativeSyntheticEvent<TextInputFocusEventData>): void => {
    setFocused(false);
    onBlur?.(event);
  };
  return (
    <TextInput
      {...rest}
      placeholderTextColor={ink.muted}
      onFocus={handleFocus}
      onBlur={handleBlur}
      style={[
        styles.base,
        recessed ? styles.recessed : styles.raised,
        focused && styles.focused,
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: touchTarget.minimum,
    borderRadius: BORDER_RADIUS.md,
    borderWidth: 1,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    color: ink.primary,
    fontSize: uiType.button.fontSize,
  },
  raised: { backgroundColor: surface.raised, borderColor: surface.hairline },
  recessed: { backgroundColor: colors.bevel.recessedSurface, borderColor: colors.bevel.edgeDark },
  focused: { borderColor: accent.primary },
});
