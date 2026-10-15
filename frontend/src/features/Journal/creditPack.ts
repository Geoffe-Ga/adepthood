/**
 * The BotMason credit pack: where its page is, and how the app offers it.
 *
 * Credits are bought outside the app, on the pack's own page, and reach the
 * Adepthood account whose email address the purchase carries. So the offer is
 * a link and a note: buy with the same email address (#3262).
 *
 * The page is configuration with no default (``EXPO_PUBLIC_CREDIT_PACK_URL``).
 * Until it is set the app neither links to it nor says credits can be bought:
 * an offer with no way to act on it is a dead end, and a placeholder URL baked
 * into a shipped binary would be a dead link that cannot be patched.
 */
import { httpsLinkOrNull } from '@/utils/httpsLink';

/** The configured pack page, or ``null`` when there is nothing safe to open. */
export function creditPackUrl(configured: string): string | null {
  return httpsLinkOrNull(configured);
}

/** The link's label. Names the thing, not an urging. */
export const CREDIT_PACK_LINK = 'Buy BotMason credits';

/** Says out loud that the tap leaves Adepthood. */
export const CREDIT_PACK_LINK_A11Y =
  'Buy BotMason credits on the credit pack page, outside Adepthood';

/** The one thing a buyer must get right for the credits to arrive. */
export const CREDIT_PACK_SAME_EMAIL =
  'Use the same email address as your Adepthood account when you buy, so the credits reach you.';
