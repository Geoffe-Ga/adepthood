import React from 'react';
import { Platform, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import type { TextInputProps } from 'react-native';

import { FEEDBACK_TEST_IDS } from './feedbackTestIds';

import { TextField } from '@/components/TextField';
import { colors, ink, rhythm, SPACING, touchTarget, type as typeRamp } from '@/design/tokens';

/** A multi-line answer opens at roughly three lines, then grows with its text. */
const MULTILINE_HEIGHT_FACTOR = 2.5;

export interface FeedbackFieldProps {
  field: string;
  label: string;
  hint: string;
  value: string;
  onChangeText: (value: string) => void;
  maxLength: number;
  multiline: boolean;
  editable: boolean;
  error?: string;
}

/**
 * Point a web input at the element that explains its error. React Native's own
 * props have no `aria-describedby`; react-native-web forwards it to the DOM, so
 * it is attached on the web only and typed through a narrowing cast, the same
 * way `writingFieldFocus` attaches its web-only CSS.
 */
function describedBy(id: string | undefined): Partial<TextInputProps> {
  if (Platform.OS !== 'web' || id === undefined) return {};
  return { 'aria-describedby': id, 'aria-invalid': true } as unknown as Partial<TextInputProps>;
}

/**
 * A labelled text field for the composer. `TextField` has no label or error of
 * its own, so this wraps it: a visible label, the label and hint as the input's
 * accessible name and hint, and an error that is tied to the input (the hint on
 * native, `aria-describedby` on the web) and announced through a live region.
 */
export function FeedbackField({
  field,
  label,
  hint,
  value,
  onChangeText,
  maxLength,
  multiline,
  editable,
  error,
}: FeedbackFieldProps): React.JSX.Element {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  const errorId = error === undefined ? undefined : FEEDBACK_TEST_IDS.fieldError(field);
  return (
    <View style={styles.wrap}>
      <Text allowFontScaling style={[t.label, styles.label]}>
        {label}
      </Text>
      <Text allowFontScaling style={[t.caption, styles.hint]}>
        {hint}
      </Text>
      <TextField
        value={value}
        onChangeText={onChangeText}
        maxLength={maxLength}
        multiline={multiline}
        editable={editable}
        allowFontScaling
        accessibilityLabel={label}
        accessibilityHint={error === undefined ? hint : `${error} ${hint}`}
        testID={FEEDBACK_TEST_IDS.field(field)}
        style={multiline ? styles.multiline : undefined}
        {...describedBy(errorId)}
      />
      {errorId === undefined ? null : (
        <Text
          allowFontScaling
          nativeID={errorId}
          testID={errorId}
          accessibilityLiveRegion="polite"
          style={[t.caption, styles.error]}
        >
          {error}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: rhythm.blockGap },
  label: { color: ink.primary },
  hint: { color: ink.soft, marginBottom: SPACING.xs },
  multiline: {
    minHeight: touchTarget.minimum * MULTILINE_HEIGHT_FACTOR,
    textAlignVertical: 'top',
  },
  error: { color: colors.destructive.text, marginTop: SPACING.xs },
});
