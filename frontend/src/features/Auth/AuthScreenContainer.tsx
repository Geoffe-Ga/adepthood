import React from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { authStyles } from './auth.styles';

interface Props {
  /** testID prefix; renders ``<id>-screen`` + ``<id>-keyboard-avoiding``. */
  testID: string;
  children: React.ReactNode;
}

/**
 * Shared full-screen wrapper for the auth screens (audit-ux-08): SafeAreaView +
 * KeyboardAvoidingView so the on-screen keyboard never covers the submit button.
 */
export function AuthScreenContainer({ testID, children }: Props): React.JSX.Element {
  return (
    <SafeAreaView style={authStyles.safeArea} testID={`${testID}-screen`}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={authStyles.container}
        testID={`${testID}-keyboard-avoiding`}
      >
        <View style={authStyles.form}>{children}</View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
