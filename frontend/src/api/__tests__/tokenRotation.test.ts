/* global describe, test, expect, beforeEach, jest */
import {
  createTokenRotation,
  MAX_REMEMBERED_ROTATIONS,
  type RotatedToken,
  type TokenRotation,
} from '../tokenRotation';

interface Deferred {
  promise: Promise<RotatedToken | null>;
  resolve: (value: RotatedToken | null) => void;
}

function deferred(): Deferred {
  let resolve: (value: RotatedToken | null) => void = () => {};
  const promise = new Promise<RotatedToken | null>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let sessionToken: string | null;
let performRefresh: jest.Mock<Promise<RotatedToken | null>, [string]>;
let onRotated: jest.Mock<void, [RotatedToken, string]>;
let rotation: TokenRotation<RotatedToken>;

beforeEach(() => {
  sessionToken = 'a';
  performRefresh = jest.fn((from: string) => Promise.resolve({ token: `${from}+` }));
  onRotated = jest.fn();
  rotation = createTokenRotation<RotatedToken>({
    performRefresh,
    currentToken: () => sessionToken,
    onRotated,
  });
});

describe('forward', () => {
  test('a token with no known rotation forwards to itself, and null to null', () => {
    expect(rotation.forward('a')).toBe('a');
    expect(rotation.forward(null)).toBeNull();
  });

  test('chains through every remembered rotation', async () => {
    await rotation.refresh('a');
    sessionToken = 'a+';
    await rotation.refresh('a+');

    expect(rotation.forward('a')).toBe('a++');
    expect(rotation.current()).toBe('a++');
  });

  test('remembers exactly MAX_REMEMBERED_ROTATIONS rotations, oldest evicted first', async () => {
    let token = 'a';
    for (let i = 0; i <= MAX_REMEMBERED_ROTATIONS; i += 1) {
      sessionToken = token;
      await rotation.refresh(token);
      token = `${token}+`;
    }
    // MAX + 1 rotations: the first is forgotten, the remaining MAX still chain
    // all the way to the newest token.
    expect(rotation.forward('a')).toBe('a');
    expect(rotation.forward('a+')).toBe(token);
  });

  test('a successor that would close a cycle is not recorded', async () => {
    await rotation.refresh('a'); // a -> a+
    sessionToken = 'a+';
    performRefresh.mockResolvedValueOnce({ token: 'a' });
    await rotation.refresh('a+'); // a server answering with a revoked token

    expect(rotation.forward('a')).toBe('a+');
    expect(rotation.forward('a+')).toBe('a+');
  });

  test('a refresh that hands back the same token is not recorded', async () => {
    performRefresh.mockResolvedValueOnce({ token: 'a' });
    await rotation.refresh('a');

    expect(rotation.forward('a')).toBe('a');
  });
});

describe('refresh', () => {
  test('performs one network refresh for the current token and publishes it', async () => {
    await expect(rotation.refresh('a')).resolves.toEqual({
      kind: 'refreshed',
      response: { token: 'a+' },
    });
    expect(performRefresh).toHaveBeenCalledTimes(1);
    expect(onRotated).toHaveBeenCalledWith({ token: 'a+' }, 'a');
  });

  test('concurrent refreshes of the same token join one network call', async () => {
    const network = deferred();
    performRefresh.mockReturnValueOnce(network.promise);

    const first = rotation.refresh('a');
    const second = rotation.refresh('a');
    network.resolve({ token: 'b' });

    await expect(first).resolves.toEqual({ kind: 'refreshed', response: { token: 'b' } });
    await expect(second).resolves.toEqual({ kind: 'refreshed', response: { token: 'b' } });
    expect(performRefresh).toHaveBeenCalledTimes(1);
    expect(onRotated).toHaveBeenCalledTimes(1);
  });

  test('a token already rotated is answered from memory, never the network', async () => {
    await rotation.refresh('a');

    await expect(rotation.refresh('a')).resolves.toEqual({ kind: 'rotated', token: 'a+' });
    expect(performRefresh).toHaveBeenCalledTimes(1);
  });

  test('the known successor is answered even while the refresh that found it is settling', async () => {
    // ``onRotated`` runs before the in-flight slot is released; a caller that
    // asks in that instant must still hear "rotated", not join the old call.
    let reentrant: Promise<unknown> | undefined;
    onRotated.mockImplementation((_response, from) => {
      reentrant = rotation.refresh(from);
    });

    await rotation.refresh('a');

    await expect(reentrant).resolves.toEqual({ kind: 'rotated', token: 'a+' });
  });

  test('a token that is neither current nor known is refused without the network', async () => {
    await expect(rotation.refresh('stranger')).resolves.toEqual({ kind: 'refused' });
    expect(performRefresh).not.toHaveBeenCalled();
  });

  test('a failed network refresh records and publishes nothing', async () => {
    performRefresh.mockResolvedValueOnce(null);

    await expect(rotation.refresh('a')).resolves.toEqual({ kind: 'failed' });
    expect(rotation.forward('a')).toBe('a');
    expect(onRotated).not.toHaveBeenCalled();
  });

  test('the rotation is recorded before it is published, and published before callers resume', async () => {
    const order: string[] = [];
    onRotated.mockImplementation((_response, from) => {
      order.push(`published; forward=${String(rotation.forward(from))}`);
    });

    const attempt = rotation.refresh('a').then(() => order.push('resumed'));
    await attempt;

    expect(order).toEqual(['published; forward=a+', 'resumed']);
  });

  test('a settled refresh frees its slot, so a later genuine refresh fires', async () => {
    await rotation.refresh('a');
    sessionToken = 'a+';
    await rotation.refresh('a+');

    expect(performRefresh).toHaveBeenCalledTimes(2);
  });
});

describe('reset and the epoch', () => {
  test('forgets every rotation', async () => {
    await rotation.refresh('a');
    rotation.reset();

    expect(rotation.forward('a')).toBe('a');
  });

  test('a refresh that resolves after a reset neither records nor publishes', async () => {
    const network = deferred();
    performRefresh.mockReturnValueOnce(network.promise);
    const stale = rotation.refresh('a');

    rotation.reset();
    network.resolve({ token: 'b' });

    await expect(stale).resolves.toEqual({ kind: 'failed' });
    expect(rotation.forward('a')).toBe('a');
    expect(onRotated).not.toHaveBeenCalled();
  });

  test('an orphaned refresh settling does not evict the newer refresh of the same token', async () => {
    const orphan = deferred();
    const fresh = deferred();
    performRefresh.mockReturnValueOnce(orphan.promise).mockReturnValueOnce(fresh.promise);

    const first = rotation.refresh('a');
    rotation.reset();
    const second = rotation.refresh('a');
    orphan.resolve(null);
    await first;

    // The newer refresh is still in flight: a third caller joins it.
    const third = rotation.refresh('a');
    fresh.resolve({ token: 'b' });

    await expect(second).resolves.toEqual({ kind: 'refreshed', response: { token: 'b' } });
    await expect(third).resolves.toEqual({ kind: 'refreshed', response: { token: 'b' } });
    expect(performRefresh).toHaveBeenCalledTimes(2);
  });
});

describe('recover', () => {
  test('an anonymous 401 with no session is no-session', async () => {
    sessionToken = null;
    await expect(rotation.recover(null)).resolves.toEqual({ kind: 'no-session' });
    expect(performRefresh).not.toHaveBeenCalled();
  });

  test('an anonymous 401 after a sign-in is superseded, not no-session', async () => {
    await expect(rotation.recover(null)).resolves.toEqual({ kind: 'superseded' });
    expect(performRefresh).not.toHaveBeenCalled();
  });

  test('a 401 on the current token refreshes it and retries with the successor', async () => {
    await expect(rotation.recover('a')).resolves.toEqual({ kind: 'rotated', token: 'a+' });
  });

  test('a 401 on an already-rotated token retries with the successor and no refresh', async () => {
    await rotation.refresh('a');
    await expect(rotation.recover('a')).resolves.toEqual({ kind: 'rotated', token: 'a+' });
    expect(performRefresh).toHaveBeenCalledTimes(1);
  });

  test('the current token failing to refresh is expired', async () => {
    performRefresh.mockResolvedValueOnce(null);
    await expect(rotation.recover('a')).resolves.toEqual({ kind: 'expired' });
  });

  test('a failure for a token the session moved past is superseded', async () => {
    const network = deferred();
    performRefresh.mockReturnValueOnce(network.promise);
    const recovering = rotation.recover('a');
    sessionToken = 'c';
    network.resolve(null);

    await expect(recovering).resolves.toEqual({ kind: 'superseded' });
  });

  test('a stranger token is superseded without the network', async () => {
    await expect(rotation.recover('stranger')).resolves.toEqual({ kind: 'superseded' });
    expect(performRefresh).not.toHaveBeenCalled();
  });

  test('a successor the session no longer holds is never handed out', async () => {
    const network = deferred();
    performRefresh.mockReturnValueOnce(network.promise);
    const recovering = rotation.recover('a');
    // The refresh lands, but the session has moved on to another token that
    // the chain from ``a`` does not reach.
    network.resolve({ token: 'b' });
    sessionToken = 'c';

    await expect(recovering).resolves.toEqual({ kind: 'superseded' });
  });

  test('a successor is handed out only when the chain reaches the current token', async () => {
    await rotation.refresh('a'); // a -> a+, recorded
    sessionToken = 'other';

    await expect(rotation.recover('a')).resolves.toEqual({ kind: 'superseded' });
  });

  describe("in 'join-only' mode", () => {
    test('rides a refresh already in flight', async () => {
      const network = deferred();
      performRefresh.mockReturnValueOnce(network.promise);
      void rotation.refresh('a');
      const recovering = rotation.recover('a', 'join-only');
      network.resolve({ token: 'b' });

      await expect(recovering).resolves.toEqual({ kind: 'rotated', token: 'b' });
      expect(performRefresh).toHaveBeenCalledTimes(1);
    });

    test('uses a remembered successor', async () => {
      await rotation.refresh('a');
      await expect(rotation.recover('a', 'join-only')).resolves.toEqual({
        kind: 'rotated',
        token: 'a+',
      });
      expect(performRefresh).toHaveBeenCalledTimes(1);
    });

    test('never starts a refresh: the current token with nothing underway is expired', async () => {
      await expect(rotation.recover('a', 'join-only')).resolves.toEqual({ kind: 'expired' });
      expect(performRefresh).not.toHaveBeenCalled();
    });

    test('a token the session moved past is superseded', async () => {
      await expect(rotation.recover('stranger', 'join-only')).resolves.toEqual({
        kind: 'superseded',
      });
      expect(performRefresh).not.toHaveBeenCalled();
    });
  });
});
