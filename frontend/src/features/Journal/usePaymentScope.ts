import { useMemo, useRef } from 'react';

import { useAuth } from '@/context/AuthContext';
import { getActiveUserGeneration, getActiveUser, parseUserId } from '@/storage/userScope';
import { decodeJwtPayload } from '@/utils/token';

/** A credential/status transition invalidates held prices before effects run. */
export function usePaymentScope(): () => boolean {
  const { token, authStatus } = useAuth();
  const namespaceEpoch = getActiveUserGeneration();
  const currentRef = useRef({ token, authStatus, namespaceEpoch });
  if (
    currentRef.current.token !== token ||
    currentRef.current.authStatus !== authStatus ||
    currentRef.current.namespaceEpoch !== namespaceEpoch
  ) {
    currentRef.current = { token, authStatus, namespaceEpoch };
  }
  const captured = currentRef.current;
  const credentialOwner =
    captured.token === null ? null : parseUserId(decodeJwtPayload(captured.token)?.sub);
  return useMemo(
    () => () =>
      captured.authStatus === 'authenticated' &&
      captured.token !== null &&
      currentRef.current === captured &&
      getActiveUserGeneration() === captured.namespaceEpoch &&
      credentialOwner !== null &&
      getActiveUser() === credentialOwner,
    [captured, credentialOwner],
  );
}
