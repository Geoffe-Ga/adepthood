import React from 'react';
import { Text } from 'react-native';

import { authStyles as styles } from './auth.styles';

import { ShowcaseCard } from '@/components/layout/ShowcaseCard';

/** Program voice beneath the wordmark — the contemplative 36-week invitation. */
const TAGLINE = 'A thirty-six week practice in becoming who you mean to be.';

/**
 * The branded editorial first impression (design-act2-10): a serif "Adepthood"
 * wordmark over a line of program voice, on the warm showcase hero. Shared
 * verbatim by Login and Signup so both screens open on the same entrance.
 */
export function AuthBrandBand(): React.JSX.Element {
  return (
    <ShowcaseCard style={styles.brandBand} testID="auth-brand-band">
      <Text style={styles.wordmark} accessibilityRole="header">
        Adepthood
      </Text>
      <Text style={styles.tagline}>{TAGLINE}</Text>
    </ShowcaseCard>
  );
}
