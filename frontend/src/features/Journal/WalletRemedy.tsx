/**
 * What an empty BotMason wallet can do about itself, said the same way wherever
 * it is said.
 *
 * Two surfaces meet an empty wallet. The refill dialog meets it after a request
 * is refused 402, and a note's letter offer meets it before any request, when
 * the price it reads already says nothing can pay (#3386). Both offer the same
 * remedy: when the balance returns, and the credit pack page where one is
 * configured (#3262). Neither offers a key, because a vault answers these and
 * never uses one. Stating the remedy once keeps the two from drifting apart.
 */
import React, { useCallback } from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View, type TextProps } from 'react-native';

import {
  CREDIT_PACK_LINK,
  CREDIT_PACK_LINK_A11Y,
  CREDIT_PACK_SAME_EMAIL,
  creditPackUrl,
} from './creditPack';

import { CREDIT_PACK_URL } from '@/config';
import { colors, editorialType, spacing, touchTarget } from '@/design/tokens';
import { openExternalUrl } from '@/utils/openExternalUrl';

/** The configured pack page, read at render: the page is meant to be replaceable. */
export function configuredCreditPackUrl(): string | null {
  return creditPackUrl(CREDIT_PACK_URL);
}

/** Preserve the server's calendar date instead of shifting it through the device zone. */
export function formatResonanceResetDate(value: string | null): string | null {
  if (value === null) return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})/u.exec(value);
  if (dateOnly === null) return null;
  const [, year, month, day] = dateOnly;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

/** When the balance comes back, from the served reset date and monthly cap. */
export function resetAvailabilityCopy(
  monthlyCap: number | null,
  monthlyResetDate: string | null,
): string {
  const reset = formatResonanceResetDate(monthlyResetDate);
  if (reset === null) return 'Check your BotMason balance again later.';
  return monthlyCap !== null && monthlyCap > 0
    ? `Your BotMason messages reset on ${reset}.`
    : `Your next monthly reset is ${reset}.`;
}

/**
 * What declining an empty-wallet remedy declines (#3388).
 *
 * The visible label stays "Not now"; the spoken name says what is actually on
 * the card. No key is ever on it, so it never mentions one.
 */
export function walletCancelA11y(packUrl: string | null): string {
  return packUrl === null
    ? 'Not now — close this message'
    : 'Not now — close without buying credits';
}

/**
 * What react-native-web adds to ``Text`` to render a real ``<a href>``.
 *
 * A pressable with the link role is focusable on the web but not keyboard
 * operable: react-native-web leaves Enter on a link to the browser's native
 * activation, and a ``div`` styled as a link has none. A real anchor has it,
 * so on the web the pack link is one, opening in a new tab like the press does.
 */
interface WebAnchorProps {
  href: string;
  hrefAttrs: { target: '_blank'; rel: string };
}

/** The pack page's own link: an anchor on the web, a press-to-open elsewhere. */
function CreditPackLink({ url, testID }: { url: string; testID: string }): React.JSX.Element {
  const open = useCallback(() => {
    void openExternalUrl(url);
  }, [url]);
  if (Platform.OS === 'web') {
    const anchor: TextProps & WebAnchorProps = {
      href: url,
      hrefAttrs: { target: '_blank', rel: 'noopener noreferrer' },
      accessibilityRole: 'link',
      accessibilityLabel: CREDIT_PACK_LINK_A11Y,
      testID,
      style: [styles.packLinkLabel, styles.webAnchor],
    };
    return (
      <View style={styles.packLink}>
        <Text {...anchor}>{CREDIT_PACK_LINK}</Text>
      </View>
    );
  }
  return (
    <TouchableOpacity
      style={styles.packLink}
      onPress={open}
      accessibilityRole="link"
      accessibilityLabel={CREDIT_PACK_LINK_A11Y}
      testID={testID}
    >
      <Text style={styles.packLinkLabel}>{CREDIT_PACK_LINK}</Text>
    </TouchableOpacity>
  );
}

/** The pack page and the one thing a buyer must get right. */
export function CreditPackOffer({
  url,
  testID,
}: {
  url: string;
  testID: string;
}): React.JSX.Element {
  return (
    <View testID={testID}>
      <CreditPackLink url={url} testID={`${testID}-link`} />
      <Text style={styles.packNote}>{CREDIT_PACK_SAME_EMAIL}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  packLink: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    marginTop: spacing(1),
  },
  // The anchor itself is the focus and hit target, so it carries the minimum.
  webAnchor: {
    minHeight: touchTarget.minimum,
    display: 'flex',
    alignItems: 'center',
    alignSelf: 'flex-start',
  },
  packLinkLabel: {
    ...editorialType.action,
    color: colors.paper.ink,
    textDecorationLine: 'underline',
  },
  packNote: {
    ...editorialType.note,
    color: colors.paper.inkSoft,
  },
});
