import { useCallback, useEffect, useRef, useState } from 'react';

import { mettaReturn, type MettaReturnState } from '@/api';
import { useAuth } from '@/context/AuthContext';
import { useMountedRef } from '@/hooks/useMountedRef';
import {
  loadReturnOfferDismissed,
  saveReturnOfferDismissed,
  type ReturnOfferIdentity,
} from '@/storage/returnOfferStorage';
import { useActiveUser, useActiveUserGeneration } from '@/storage/useActiveUser';
import {
  getActiveUser,
  getActiveUserGeneration,
  isActiveUserTransitioning,
  parseUserId,
} from '@/storage/userScope';
import { decodeJwtPayload } from '@/utils/token';

const EMPTY: MettaReturnState = {
  eligible: false,
  weeks: [],
  arc: null,
  offer_episode: null,
  offer_dismissed: false,
  released_habits: [],
};
interface ReturnScope {
  generation: number;
  credentials: { userId: number; token: string } | null;
  current: () => boolean;
}
interface MountedReturnScope extends ReturnScope {
  /**
   * Identifies the signed-in owner session, ``null`` while unauthorized. Unlike
   * ``current`` it survives a same-account token renewal, so owner-bound
   * transient UI resets on a genuine lifecycle change, not every rotation.
   */
  session: string | null;
}
type Publish = (_state: MettaReturnState) => void;

function cacheChoice(identity: ReturnOfferIdentity): void {
  void saveReturnOfferDismissed(identity, true).catch(() => {
    // A failed write cannot decline a different episode or account.
  });
}
function offerChanged(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 409;
}
function identityFor(scope: ReturnScope, state: MettaReturnState): ReturnOfferIdentity | null {
  if (scope.credentials === null || state.offer_episode === null) return null;
  return { userId: scope.credentials.userId, episode: state.offer_episode };
}

/** Keep credentials and namespace together, including an A → B → A without a render. */
function useReturnScope(): MountedReturnScope {
  const { token } = useAuth();
  const latestToken = useRef(token);
  latestToken.current = token;
  const owner = useActiveUser();
  const generation = useActiveUserGeneration();
  const mounted = useMountedRef();
  // Cleanup moves the generation (and re-renders this hook) while the outgoing
  // token and namespace are still in hand; nothing is authorized until the
  // incoming scope is committed (#3368).
  const authorized =
    !isActiveUserTransitioning() &&
    owner !== null &&
    token !== null &&
    parseUserId(decodeJwtPayload(token)?.sub) === owner;
  const current = useCallback(
    () =>
      mounted.current &&
      authorized &&
      latestToken.current === token &&
      getActiveUser() === owner &&
      getActiveUserGeneration() === generation,
    [mounted, authorized, owner, generation, token],
  );
  return {
    generation,
    session: authorized ? `${owner}@${generation}` : null,
    current,
    credentials: authorized && owner !== null && token !== null ? { userId: owner, token } : null,
  };
}

async function reload(scope: ReturnScope, publish: Publish): Promise<void> {
  if (!scope.current() || scope.credentials === null) return;
  try {
    await acceptState(scope, await mettaReturn.state(scope.credentials.token), publish);
  } catch {
    // An unconfirmed read leaves the current local choice quiet.
  }
}
async function confirmChoice(
  scope: ReturnScope,
  identity: ReturnOfferIdentity,
  publish: Publish,
): Promise<void> {
  if (!scope.current() || scope.credentials === null) return;
  try {
    const confirmed = await mettaReturn.dismissOffer(
      { expected_offer_episode: identity.episode },
      scope.credentials.token,
    );
    await acceptState(scope, confirmed, publish);
  } catch (error) {
    if (offerChanged(error)) await reload(scope, publish);
    // Uncertain writes retain only this account's observed episode choice.
  }
}
async function acceptState(
  scope: ReturnScope,
  state: MettaReturnState,
  publish: Publish,
): Promise<void> {
  if (!scope.current()) return;
  const identity = identityFor(scope, state);
  if (identity === null || state.offer_dismissed) {
    publish(state);
    if (identity !== null) cacheChoice(identity);
    return;
  }
  const pending = await loadReturnOfferDismissed(identity);
  if (!scope.current()) return;
  publish({ ...state, offer_dismissed: pending });
  if (pending) await confirmChoice(scope, identity, publish);
}

/** Whether to read the state at all, and a key that asks for a fresh read. */
interface ReadOptions {
  enabled?: boolean;
  refreshKey?: number;
}

function useObservation(scope: ReturnScope, { enabled = true, refreshKey = 0 }: ReadOptions) {
  const { generation, current } = scope;
  const credentials = scope.credentials;
  const token = credentials?.token;
  const userId = credentials?.userId;
  const [observation, setObservation] = useState({ generation: -1, state: EMPTY });
  const latest = useRef(observation);
  latest.current = observation;
  const publish = useCallback(
    (state: MettaReturnState): void => {
      if (!current()) return;
      latest.current = { generation, state };
      setObservation(latest.current);
    },
    [current, generation],
  );
  useEffect(() => {
    // A disabled read stays EMPTY: a declined ring costs no request at all.
    if (!enabled) return;
    // Rebuild the immutable captured scope from primitive dependencies so state
    // updates do not start another read or replace an in-flight observation.
    void reload(
      {
        generation,
        current,
        credentials: userId === undefined || token === undefined ? null : { userId, token },
      },
      publish,
    );
  }, [generation, current, userId, token, publish, enabled, refreshKey]);
  return {
    state: current() && observation.generation === generation ? observation.state : EMPTY,
    latest,
    publish,
    setObservation,
  };
}

function useDeclineEpisode(scope: ReturnScope, observation: ReturnType<typeof useObservation>) {
  const { generation, current } = scope;
  const { state, latest, publish } = observation;
  const token = scope.credentials?.token ?? null;
  const userId = scope.credentials?.userId;
  const dismissOffer = useCallback(async (): Promise<void> => {
    if (
      !current() ||
      latest.current.generation !== generation ||
      latest.current.state.offer_episode !== state.offer_episode
    )
      return;
    const captured = {
      generation,
      current,
      credentials: userId === undefined || token === null ? null : { userId, token },
    };
    const identity = identityFor(captured, state);
    if (identity === null) return;
    publish({ ...state, offer_dismissed: true });
    cacheChoice(identity);
    await confirmChoice(captured, identity, publish);
  }, [current, latest, generation, userId, token, state, publish]);
  return dismissOffer;
}

function useStateWriters(
  scope: ReturnScope,
  setObservation: ReturnType<typeof useObservation>['setObservation'],
) {
  const { generation, current } = scope;
  const setArc = useCallback(
    (arc: MettaReturnState['arc']): void => {
      if (current()) setObservation((old) => ({ generation, state: { ...old.state, arc } }));
    },
    [current, generation, setObservation],
  );
  const setReleasedHabits = useCallback(
    (released_habits: MettaReturnState['released_habits']): void => {
      if (current())
        setObservation((old) => ({ generation, state: { ...old.state, released_habits } }));
    },
    [current, generation, setObservation],
  );
  return { setArc, setReleasedHabits };
}

/** Load and decline only an observed server episode, never a guessed coordinate. */
export function useReturnOfferState(options: ReadOptions = {}) {
  const scope = useReturnScope();
  const observation = useObservation(scope, options);
  const dismissOffer = useDeclineEpisode(scope, observation);
  const writers = useStateWriters(scope, observation.setObservation);
  const state = observation.state;
  return {
    ...state,
    dismissed: state.offer_dismissed,
    releasedHabits: state.released_habits,
    current: scope.current,
    session: scope.session,
    token: scope.credentials?.token ?? null,
    ...writers,
    dismissOffer,
  };
}
