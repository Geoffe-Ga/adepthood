import { captureSessionToken } from '@/api';
import { getActiveUser, getActiveUserGeneration, parseUserId } from '@/storage/userScope';
import { decodeJwtPayload } from '@/utils/token';

export interface CourseSession {
  token: string;
  owner: number;
  generation: number;
  current: () => boolean;
}

/** Bind a reading request to the same authenticated identity as its local cache. */
export function captureCourseSession(): CourseSession | null {
  const owner = getActiveUser();
  const generation = getActiveUserGeneration();
  const token = captureSessionToken();
  if (owner === null || token === undefined || parseUserId(decodeJwtPayload(token)?.sub) !== owner)
    return null;
  return {
    token,
    owner,
    generation,
    current: () => generation === getActiveUserGeneration() && owner === getActiveUser(),
  };
}
