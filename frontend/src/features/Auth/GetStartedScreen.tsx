import React from 'react';
import { Text, TouchableOpacity } from 'react-native';

import { authStyles as styles } from './auth.styles';
import { AuthBrandBand } from './AuthBrandBand';
import { AuthScreenContainer } from './AuthScreenContainer';

import { Button } from '@/components/Button';
import { CalloutBand } from '@/components/layout/CalloutBand';
import { GUMROAD_PRODUCT_URL } from '@/config';
import { openExternalUrl } from '@/utils/openExternalUrl';

const TITLE = 'Choose your depth';

// Gift economy first, price never. Nothing here should read as urgency,
// scarcity, or a favour owed — the invitation has to be genuinely declinable.
const LEAD = 'Adepthood is offered in the gift economy: pay what feels right, starting at zero.';
const BODY =
  'Take the course home from Gumroad, then bring your license key back here to make an account.';

const BUY_LABEL = 'Get Adepthood on Gumroad';
const HAVE_KEY_LABEL = 'I have a license key';

interface Props {
  navigation: { navigate: (_screen: string) => void };
}

/**
 * The pre-auth surface: the first thing an anonymous visitor sees. It explains
 * what Adepthood costs (whatever you decide, including nothing), sends buyers to
 * Gumroad, and keeps both the signup form and the log-in form one tap away.
 *
 * The paid content is real — a license key gates the account, this screen is
 * the honest telling of that, not a pressure tactic dressed up as one. There
 * is no OAuth-style callback: the buyer leaves for Gumroad in their own
 * browser tab and comes back to this app manually, license key in hand, to
 * tap "I have a license key" themselves.
 */
export default function GetStartedScreen({ navigation }: Props): React.JSX.Element {
  // ``openExternalUrl`` already reports its own failures and resolves false
  // rather than throwing; the catch guards the screen against an unhandled
  // rejection so a missing browser can never unmount the CTA.
  const handleBuy = (): void => {
    void openExternalUrl(GUMROAD_PRODUCT_URL).catch(() => undefined);
  };

  return (
    <AuthScreenContainer testID="get-started">
      <AuthBrandBand />
      <Text style={styles.title}>{TITLE}</Text>
      <Text style={styles.lead}>{LEAD}</Text>
      <Text style={styles.body}>{BODY}</Text>
      <CalloutBand label={BUY_LABEL} onPress={handleBuy} testID="get-started-buy" />
      <Button
        variant="secondary"
        label={HAVE_KEY_LABEL}
        onPress={() => navigation.navigate('Signup')}
        style={styles.ctaSpacing}
        testID="get-started-have-key"
      />
      <TouchableOpacity
        accessibilityLabel="Go to log-in screen"
        accessibilityRole="link"
        onPress={() => navigation.navigate('Login')}
      >
        <Text style={styles.link}>
          Already have an account? <Text style={styles.linkBold}>Log In</Text>
        </Text>
      </TouchableOpacity>
    </AuthScreenContainer>
  );
}
