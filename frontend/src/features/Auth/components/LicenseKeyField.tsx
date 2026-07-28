import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import type { TextInputProps } from 'react-native';

import { authStyles as styles } from '../auth.styles';

import { TextField } from '@/components/TextField';
import { SPACING, touchTarget } from '@/design/tokens';

// The help link is deliberately quiet type, so its rendered box is a single
// short line — well under the 44dp accessible minimum. Grow the tap area
// rather than the glyphs: half the shortfall on every edge, measured against
// a conservative floor for one line of link copy.
const HELP_LINK_MIN_LINE_BOX = SPACING.lg;
const HELP_LINK_SLOP = (touchTarget.minimum - HELP_LINK_MIN_LINE_BOX) / 2;
const HELP_LINK_HIT_SLOP = {
  top: HELP_LINK_SLOP,
  bottom: HELP_LINK_SLOP,
  left: HELP_LINK_SLOP,
  right: HELP_LINK_SLOP,
};

interface LicenseKeyFieldProps extends TextInputProps {
  /** Inline, field-scoped error copy; hidden when null. */
  error?: string | null;
  /** Opens the "where do I find my key" help page. */
  onPressHelp: () => void;
}

/**
 * Gumroad license key input for the signup form, with its inline error and a
 * self-serve help link.
 *
 * Deliberately NOT ``secureTextEntry``: a license key is transcribed or pasted
 * from a receipt, and masking it only makes typos invisible. For the same
 * reason autocorrect, capitalisation and spellcheck are all off. Keeping
 * password managers from offering to autofill — or store — a credential that is
 * not a password takes both opt-outs: ``textContentType="none"`` covers iOS,
 * while ``autoComplete="off"`` is what suppresses Android's autofill
 * heuristics (which otherwise fire regardless of ``textContentType``) and the
 * browser's form history on web.
 */
export function LicenseKeyField({
  error,
  onPressHelp,
  ...rest
}: LicenseKeyFieldProps): React.JSX.Element {
  return (
    <>
      <TextField
        placeholder="License key"
        accessibilityLabel="Gumroad license key"
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        textContentType="none"
        autoComplete="off"
        {...rest}
      />
      {error ? (
        <Text
          // The error appears in place, with no mount/unmount cycle to cue a
          // screen reader — so pair the alert role with a live region.
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={styles.fieldError}
          testID="signup-license-error"
        >
          {error}
        </Text>
      ) : null}
      <TouchableOpacity
        accessibilityLabel="Find your license key"
        accessibilityRole="link"
        hitSlop={HELP_LINK_HIT_SLOP}
        onPress={onPressHelp}
        testID="signup-license-help"
      >
        <Text style={styles.helpLink}>Where&apos;s my key?</Text>
      </TouchableOpacity>
    </>
  );
}
