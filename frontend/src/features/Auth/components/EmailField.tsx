import React from 'react';
import type { TextInputProps } from 'react-native';

import { TextField } from '@/components/TextField';

/**
 * Shared email input for the Auth screens. Wraps the warm {@link TextField}
 * with the email-specific keyboard/capitalisation props that were previously
 * copy-pasted across Login, Signup, Forgot Password and the re-auth sheet
 * (#871). Callers still own value/onChangeText/testID/accessibilityLabel/style,
 * so per-screen labels and ids are preserved unchanged.
 */
export function EmailField(props: TextInputProps): React.JSX.Element {
  return (
    <TextField placeholder="Email" autoCapitalize="none" keyboardType="email-address" {...props} />
  );
}
