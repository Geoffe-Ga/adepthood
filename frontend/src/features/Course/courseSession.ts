import { captureSessionToken } from '@/api';
import { captureAuthScope, isAuthScopeCurrent } from '@/api/sessionToken';
import { parseUserId } from '@/storage/userScope';
import { decodeJwtPayload } from '@/utils/token';

export interface CourseSession {
  token: string;
  owner: number;
  generation: number;
  /** The authentication session the request was captured in (#3423). */
  session: number;
  current: () => boolean;
}

/**
 * Bind a reading request to the same authenticated identity as its local cache,
 * and to the session that issued it: the same account signing back in after a
 * 401 is a new session whose screens must not take the old one's answers.
 */
export function captureCourseSession(): CourseSession | null {
  const scope = captureAuthScope();
  const { owner } = scope;
  const token = captureSessionToken();
  if (owner === null || token === undefined || parseUserId(decodeJwtPayload(token)?.sub) !== owner)
    return null;
  return { ...scope, owner, token, current: () => isAuthScopeCurrent(scope) };
}
