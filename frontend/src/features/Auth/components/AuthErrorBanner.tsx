import React from 'react';
import { Text } from 'react-native';

import { authStyles } from '../auth.styles';

interface AuthErrorBannerProps {
  /** Form-level copy; the banner renders nothing when there is none. */
  message: string | null;
  /** Stable id for the one error channel this screen owns. */
  testID: string;
}

/**
 * The form-level error slot every auth screen draws.
 *
 * The message appears in place, with no mount/unmount cycle a screen reader
 * would otherwise narrate, so the alert role is paired with a live region --
 * the same pairing {@link ../../components/LicenseKeyField} makes for its inline
 * field error. Authored once here because a banner that announces itself on four
 * screens and stays silent on the fifth is worse than one that never did.
 */
export function AuthErrorBanner({
  message,
  testID,
}: AuthErrorBannerProps): React.JSX.Element | null {
  if (message === null) return null;
  return (
    <Text
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={authStyles.error}
      testID={testID}
    >
      {message}
    </Text>
  );
}
