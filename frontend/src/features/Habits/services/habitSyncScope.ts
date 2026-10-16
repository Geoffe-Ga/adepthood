import { getAuthSession } from '../../../api/sessionToken';
import { getActiveUserGeneration } from '../../../storage/userScope';

/**
 * Name the account generation and authentication session a habit read belongs
 * to (#3328). A read finished under another account, or under an earlier
 * session of the same account, describes rows the live session may not own,
 * so a caller waiting on "this account's habits have loaded" compares keys
 * rather than trusting whatever the store last held.
 */
export const habitSyncScopeKey = (
  generation: number = getActiveUserGeneration(),
  session: number = getAuthSession(),
): string => `${generation}:${session}`;
