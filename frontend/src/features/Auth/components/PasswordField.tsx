import React from 'react';
import type { TextInputProps } from 'react-native';

import { TextField } from '@/components/TextField';

/**
 * Shared password input for the Auth screens. Wraps the warm {@link TextField}
 * with ``secureTextEntry`` so the masking that was duplicated across Login,
 * Signup, Reset Password and the re-auth sheet (#871) lives in one place.
 * Callers still own value/onChangeText/testID/accessibilityLabel/style/
 * placeholder/textContentType, so per-screen labels and ids are preserved.
 */
export function PasswordField(props: TextInputProps): React.JSX.Element {
  return <TextField secureTextEntry placeholder="Password" {...props} />;
}
