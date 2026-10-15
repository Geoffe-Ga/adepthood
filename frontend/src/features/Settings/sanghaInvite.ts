/**
 * The Digital Sangha invitation: where its door leads, and how it is worded.
 *
 * NORTH-STAR names the Sangha as one of the optional depths, and the depth
 * rules govern it: it is *offered*, never pushed. The community itself lives
 * on Discord, so Adepthood's entire job here is to hold a door open and say
 * so plainly. There is no membership count, no unread badge, no streak and no
 * second prompt, because a community rendered as a metric stops being one.
 *
 * The invite is configuration rather than a literal. A permanent Discord
 * invite is the owner's to create, and a link baked into a shipped binary
 * cannot be replaced when it dies. That is also why the resolver fails closed:
 * with nothing configured the app simply does not mention the Sangha, which is
 * an absent invitation rather than a broken one.
 */

import { httpsLinkOrNull } from '@/utils/httpsLink';

/**
 * Resolve the configured invite, or ``null`` when there is nothing safe to
 * open. The rule is the one every configured door out of the app shares
 * (``httpsLinkOrNull``): a non-empty ``https`` URL, trimmed, or nothing.
 */
export function sanghaInviteUrl(configured: string): string | null {
  return httpsLinkOrNull(configured);
}

/** Section heading. Names the depth, promises nothing about it. */
export const SANGHA_SECTION_TITLE = 'Digital Sangha';

/**
 * The invitation itself. It says the app is whole without the Sangha, because
 * that is true and because the alternative — implying something is missing
 * until you go — is the pressure this depth is forbidden to apply.
 */
export const SANGHA_LEAD =
  'There is a Discord where people walking this path keep each other company. ' +
  'It is a door left open — Adepthood is whole without it.';

/**
 * Where the door is closed. Declining is the same one tap as accepting, on the
 * Sangha switch the Choose-your-depths section already owns; naming it here
 * means no one has to hunt for it, and it stays a single mechanism rather than
 * a second, competing one.
 */
export const SANGHA_DECLINE_HINT =
  'Not for you? Turn Sangha off in Choose your depths, and this door stops being offered.';

/** Row label. A place, not an instruction. */
export const SANGHA_ROW_LABEL = 'Company on Discord';

/**
 * Row description. Says out loud that the tap leaves Adepthood and lands
 * somewhere governed by somebody else, which is the one thing a person should
 * know before following it.
 */
export const SANGHA_ROW_DESCRIPTION = 'Opens Discord outside Adepthood, under its own terms.';
