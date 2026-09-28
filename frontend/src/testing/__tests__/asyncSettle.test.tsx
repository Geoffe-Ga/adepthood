import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { act, render, screen } from '@testing-library/react-native';
import React, { useEffect, useState } from 'react';
import { Text } from 'react-native';

import { settle } from '@/testing/asyncSettle';

/** Deeper than any resolved-mock chain a screen under test actually builds. */
const CHAIN_HOPS = 10;

/**
 * A component whose visible state lands only after an already-resolved mock
 * promise and a further chain of microtask hops -- the shape of a screen that
 * awaits its API mock, then a store update, then a derived selector.
 */
function LoadsThroughAChain({ load }: { load: () => Promise<string> }): React.JSX.Element {
  const [label, setLabel] = useState('loading');
  useEffect(() => {
    let live = true;
    void (async () => {
      let value = await load();
      for (let hop = 0; hop < CHAIN_HOPS; hop += 1) {
        value = await Promise.resolve(value);
      }
      if (live) {
        setLabel(value);
      }
    })();
    return () => {
      live = false;
    };
  }, [load]);
  return <Text>{label}</Text>;
}

describe('settle()', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('commits state that lands through a chain of already-resolved promises', async () => {
    const load = jest.fn(() => Promise.resolve('loaded'));
    render(<LoadsThroughAChain load={load} />);

    // Negative control: nothing has settled yet, so a synchronous read after
    // `settle()` below is only meaningful because this one fails first.
    expect(screen.queryByText('loaded')).toBeNull();

    await settle();

    expect(screen.getByText('loaded')).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('settles the same chain under fake timers, without advancing the clock', async () => {
    jest.useFakeTimers();
    const before = Date.now();
    render(<LoadsThroughAChain load={() => Promise.resolve('loaded')} />);
    expect(screen.queryByText('loaded')).toBeNull();

    await settle();

    expect(screen.getByText('loaded')).toBeTruthy();
    expect(Date.now()).toBe(before);
  });
});

describe('act() through the jest.setup.js containment wrapper', () => {
  it("still resolves to the async callback's own value", async () => {
    const value = await act(async () => 'from the callback');

    expect(value).toBe('from the callback');
  });

  it("still rejects with the async callback's own error", async () => {
    await expect(
      act(async () => {
        throw new Error('from the callback');
      }),
    ).rejects.toThrow('from the callback');
  });
});
