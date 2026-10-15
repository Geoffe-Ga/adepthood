import { useEffect, useRef, useState } from 'react';

import { captureSessionToken, userPractices } from '@/api';
import type { UserPractice } from '@/api';
import { formatApiError } from '@/api/errorMessages';
import { getActiveUser, getActiveUserGeneration, parseUserId } from '@/storage/userScope';
import { decodeJwtPayload } from '@/utils/token';

function ownerToken(owner: number | null): string | null {
  const token = captureSessionToken();
  return owner !== null &&
    token !== undefined &&
    parseUserId(decodeJwtPayload(token)?.sub) === owner
    ? token
    : null;
}

const LINK_FALLBACK = "We couldn't save this habit link. Check your connection and try again.";

interface LinkParams {
  userPractice: UserPractice;
  onUpdated: (_next: UserPractice) => void;
}

interface LinkState {
  busy: boolean;
  error: string | null;
  save: (_habitId: number | null) => Promise<boolean>;
}

/** Confirm the server write before changing a link; an old owner cannot adopt its result. */
export function usePracticeHabitLink({ userPractice, onUpdated }: LinkParams): LinkState {
  const owner = getActiveUser();
  const generation = getActiveUserGeneration();
  const key = `${generation}:${owner}:${userPractice.id}`;
  const current = useRef({ key, owner });
  if (current.current.key !== key) current.current = { key, owner };
  const identity = current.current;
  const mounted = useRef(true);
  const pending = useRef<typeof identity | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setBusy(false);
    setError(null);
  }, [identity]);
  const save = async (habitId: number | null): Promise<boolean> => {
    const token = ownerToken(owner);
    if (token === null || pending.current === identity) return false;
    const isCurrent = (): boolean =>
      mounted.current &&
      current.current === identity &&
      getActiveUser() === owner &&
      getActiveUserGeneration() === generation;
    if (!isCurrent()) return false;
    pending.current = identity;
    setBusy(true);
    setError(null);
    try {
      const confirmed = await userPractices.linkHabit(userPractice.id, habitId, token);
      if (!isCurrent()) return false;
      onUpdated(confirmed);
      return true;
    } catch (err) {
      if (isCurrent()) setError(formatApiError(err, { fallback: LINK_FALLBACK }));
      return false;
    } finally {
      if (pending.current === identity) pending.current = null;
      if (isCurrent()) setBusy(false);
    }
  };
  return { busy, error, save };
}
