/**
 * ``useAuthLineage`` — the authenticated session a screen's held work belongs to.
 *
 * A lineage is one authenticated session of one account: the credential's
 * owner is the active account, at one account generation, inside one
 * authentication session (``getAuthSession``). Anything else moving -- the
 * status leaving ``authenticated``, another owner, an A to B to A switch, a
 * sign-out, or the same account signing back in after a 401 -- starts a new
 * lineage, and every fence captured under the old one answers ``false`` from
 * then on, so no held answer can land in a session that never asked for it.
 *
 * A token rotation inside the session is not a new lineage (#3387, #3452). The
 * API client renews only a credential of the live session and forwards a held
 * request's credential to its successor, and the session counter never moves
 * on a renewal, so the token itself is left out of the fence: work that
 * crossed a proactive refresh, or its own 401-refresh-retry, still settles
 * where it was asked. Account equality alone is never enough; the session and
 * generation terms carry the rest.
 *
 * ``isCurrent`` keeps its identity across a renewal and is replaced on every
 * boundary. ``epoch`` moves with it, so a screen can reset owner-bound UI on a
 * real boundary without resetting it on every rotation.
 */
import { useMemo, useRef } from 'react';

import { getAuthSession, isAuthScopeCurrent } from '@/api/sessionToken';
import { useAuth } from '@/context/AuthContext';
import { getActiveUser, getActiveUserGeneration, parseUserId } from '@/storage/userScope';
import { decodeJwtPayload } from '@/utils/token';

export interface AuthLineage {
  /** Bumped on every boundary this hook renders; never on a renewal. */
  readonly epoch: number;
  /** Whether work captured under this lineage may still land. */
  readonly isCurrent: () => boolean;
}

export function useAuthLineage(): AuthLineage {
  const { token, authStatus } = useAuth();
  const credentialOwner = token === null ? null : parseUserId(decodeJwtPayload(token)?.sub);
  const owner = getActiveUser();
  const generation = getActiveUserGeneration();
  const session = getAuthSession();
  const key = `${authStatus}|${credentialOwner}|${owner}|${generation}|${session}`;
  const lineageRef = useRef({ key, epoch: 0 });
  if (lineageRef.current.key !== key) {
    lineageRef.current = { key, epoch: lineageRef.current.epoch + 1 };
  }
  const { epoch } = lineageRef.current;
  const admits = authStatus === 'authenticated' && credentialOwner !== null;
  return useMemo(
    () => ({
      epoch,
      isCurrent: () =>
        admits &&
        lineageRef.current.epoch === epoch &&
        owner === credentialOwner &&
        isAuthScopeCurrent({ owner, generation, session }),
    }),
    [admits, credentialOwner, epoch, generation, owner, session],
  );
}
