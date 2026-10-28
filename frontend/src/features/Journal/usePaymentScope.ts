import { useMemo, useRef } from 'react';

import { getAuthSession, isAuthScopeCurrent, type AuthScope } from '@/api/sessionToken';
import { useAuth } from '@/context/AuthContext';
import { getActiveUserGeneration, getActiveUser, parseUserId } from '@/storage/userScope';
import { decodeJwtPayload } from '@/utils/token';

/**
 * The payer lineage a held price, preflight or paid request belongs to.
 *
 * A lineage is one authenticated session of one account: the credential's
 * owner is the active account, at one account generation, inside one
 * authentication session (``getAuthSession``). Anything else moving -- the
 * status leaving ``authenticated``, another owner, an A to B to A switch, a
 * sign-out, or the same account signing back in after a 401 -- starts a new
 * lineage, and every fence captured under the old one answers ``false`` from
 * then on, so no held price or outcome can run for a session that never saw
 * it.
 *
 * A token rotation inside the session is not a new lineage (#3387, #3409,
 * #3411). The API client renews only a credential of the live session, and
 * the session counter never moves on a renewal, so the token itself is left
 * out of the fence: a usage read, a reading or a letter that crossed a
 * proactive refresh, or its own 401-refresh-retry, still settles where it
 * was asked. Account equality alone is never enough; the session and
 * generation terms carry the rest.
 */
export function usePaymentScope(): () => boolean {
  const { token, authStatus } = useAuth();
  const credentialOwner = token === null ? null : parseUserId(decodeJwtPayload(token)?.sub);
  const scope: AuthScope = {
    owner: getActiveUser(),
    generation: getActiveUserGeneration(),
    session: getAuthSession(),
  };
  const key = `${authStatus}|${credentialOwner}|${scope.owner}|${scope.generation}|${scope.session}`;
  const lineageRef = useRef({ key, epoch: 0 });
  if (lineageRef.current.key !== key) {
    lineageRef.current = { key, epoch: lineageRef.current.epoch + 1 };
  }
  const { epoch } = lineageRef.current;
  const admits = authStatus === 'authenticated' && credentialOwner !== null;
  const { owner, generation, session } = scope;
  return useMemo(
    () => () =>
      admits &&
      lineageRef.current.epoch === epoch &&
      owner === credentialOwner &&
      isAuthScopeCurrent({ owner, generation, session }),
    [admits, credentialOwner, epoch, generation, owner, session],
  );
}
