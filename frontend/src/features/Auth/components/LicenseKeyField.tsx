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

/**
 * What the signup form's single license field answers to. Any screen that draws
 * two of these at once — the social row, with both providers at their license
 * step — must override all three, or it ships a duplicate accessible name and a
 * testID two nodes answer to.
 */
const DEFAULT_ERROR_TEST_ID = 'signup-license-error';
const DEFAULT_HELP_TEST_ID = 'signup-license-help';
const DEFAULT_HELP_LABEL = 'Find your license key';

interface LicenseKeyFieldProps extends TextInputProps {
  /** Inline, field-scoped error copy; hidden when null. */
  error?: string | null;
  /** Opens the "where do I find my key" help page. */
  onPressHelp: () => void;
  /** Identifiers for the error slot and the help link, scoped by the caller when it draws more than one field. */
  errorTestID?: string;
  helpTestID?: string;
  /** The help link's accessible name — likewise scoped when two links are on screen together. */
  helpAccessibilityLabel?: string;
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
 *
 * The input's own accessible name arrives through the spread, which is applied
 * last so a caller drawing two fields can name each one for its provider.
 */
export function LicenseKeyField({
  error,
  onPressHelp,
  errorTestID = DEFAULT_ERROR_TEST_ID,
  helpTestID = DEFAULT_HELP_TEST_ID,
  helpAccessibilityLabel = DEFAULT_HELP_LABEL,
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
          testID={errorTestID}
        >
          {error}
        </Text>
      ) : null}
      <TouchableOpacity
        accessibilityLabel={helpAccessibilityLabel}
        accessibilityRole="link"
        hitSlop={HELP_LINK_HIT_SLOP}
        onPress={onPressHelp}
        testID={helpTestID}
      >
        <Text style={styles.helpLink}>Where&apos;s my key?</Text>
      </TouchableOpacity>
    </>
  );
}
