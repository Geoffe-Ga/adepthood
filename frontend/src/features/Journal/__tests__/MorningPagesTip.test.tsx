/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import { ranksOrShames } from '@/features/Map/__tests__/copyIntentRule';

const mockLoad = jest.fn() as jest.MockedFunction<() => Promise<boolean>>;
const mockSave = jest.fn() as jest.MockedFunction<(_v: boolean) => Promise<void>>;
const mockOnBegin = jest.fn();

jest.mock('@/storage/morningPagesTipStorage', () => ({
  loadMorningPagesTipDismissed: (...a: unknown[]) =>
    (mockLoad as unknown as (...x: unknown[]) => unknown)(...a),
  saveMorningPagesTipDismissed: (...a: unknown[]) =>
    (mockSave as unknown as (...x: unknown[]) => unknown)(...a),
}));

const MorningPagesTip = require('../MorningPagesTip').default;

type RenderedNode = {
  children?: (RenderedNode | string)[] | null;
  props?: { accessibilityLabel?: unknown };
};

function collectRenderedStrings(node: RenderedNode | string): string[] {
  if (typeof node === 'string') {
    return [node];
  }
  const collected: string[] = [];
  const label = node.props ? node.props.accessibilityLabel : undefined;
  if (typeof label === 'string') {
    collected.push(label);
  }
  for (const child of node.children ?? []) {
    collected.push(...collectRenderedStrings(child));
  }
  return collected;
}

beforeEach(() => {
  mockLoad.mockReset();
  mockSave.mockReset();
  mockOnBegin.mockReset();
  mockLoad.mockResolvedValue(false);
  mockSave.mockResolvedValue(undefined);
});

/**
 * Swap the flat mocks for a fake that actually remembers what was written.
 *
 * The default `mockLoad` answers `false` unconditionally, which is fine for the
 * single-render tests but useless for anything about a *later* visit: a remount
 * would report "not dismissed" however the component behaved. Tests that turn on
 * persistence call this so their assertions depend on the write.
 */
function useStatefulStorage(): void {
  let stored = false;
  mockLoad.mockImplementation(() => Promise.resolve(stored));
  mockSave.mockImplementation((value: boolean) => {
    stored = value;
    return Promise.resolve();
  });
}

describe('MorningPagesTip', () => {
  it('renders the tip when the dismissal flag is unset', async () => {
    const { findByTestId } = render(<MorningPagesTip onBegin={mockOnBegin} />);
    expect(await findByTestId('journal-morning-pages-tip')).toBeTruthy();
  });

  it('renders nothing when the tip was already dismissed', async () => {
    mockLoad.mockResolvedValue(true);
    const { queryByTestId } = render(<MorningPagesTip onBegin={mockOnBegin} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(queryByTestId('journal-morning-pages-tip')).toBeNull();
  });

  it('renders nothing while the persisted flag is still loading, so the tip never flashes', () => {
    mockLoad.mockImplementation(() => new Promise<boolean>(() => undefined));
    const { queryByTestId } = render(<MorningPagesTip onBegin={mockOnBegin} />);
    expect(queryByTestId('journal-morning-pages-tip')).toBeNull();
  });

  it('dismissing persists true and hides the band without invoking onBegin', async () => {
    const { findByTestId, getByTestId, queryByTestId } = render(
      <MorningPagesTip onBegin={mockOnBegin} />,
    );
    await findByTestId('journal-morning-pages-tip');

    await act(async () => {
      fireEvent.press(getByTestId('journal-morning-pages-dismiss'));
    });

    expect(mockSave).toHaveBeenCalledWith(true);
    expect(mockOnBegin).not.toHaveBeenCalled();
    await waitFor(() => expect(queryByTestId('journal-morning-pages-tip')).toBeNull());
  });

  it('the CTA calls onBegin and leaves the tip in place — beginning is not declining', async () => {
    const { findByTestId, getByTestId, queryByTestId } = render(
      <MorningPagesTip onBegin={mockOnBegin} />,
    );
    await findByTestId('journal-morning-pages-tip');

    await act(async () => {
      fireEvent.press(getByTestId('journal-morning-pages-tip'));
    });

    expect(mockOnBegin).toHaveBeenCalledTimes(1);
    // The inversion of the original assertion, kept rather than deleted so the
    // reversal of #1889's "starting an entry also counts as dismissal" stays
    // legible here. Taking up the invitation is the opposite of declining it.
    expect(mockSave).not.toHaveBeenCalled();
    expect(queryByTestId('journal-morning-pages-tip')).not.toBeNull();
  });

  it('the tip is still there on the next visit after beginning a page', async () => {
    // The criterion is about the *next* shelf visit, not just the press: a
    // component that skipped the write but still set local state would satisfy
    // the test above and still hide the tip for the rest of the session.
    //
    // The default mocks cannot show that. `mockLoad` is pinned to `false` in
    // `beforeEach`, so a remount reports "not dismissed" no matter what was
    // written -- the assertion would hold even if the CTA still persisted.
    // So this drives a fake that actually round-trips, and the sibling test
    // below dismisses through the same fake to prove it can report `true`.
    useStatefulStorage();

    const first = render(<MorningPagesTip onBegin={mockOnBegin} />);
    await first.findByTestId('journal-morning-pages-tip');
    await act(async () => {
      fireEvent.press(first.getByTestId('journal-morning-pages-tip'));
    });
    first.unmount();

    const remounted = render(<MorningPagesTip onBegin={mockOnBegin} />);
    expect(await remounted.findByTestId('journal-morning-pages-tip')).toBeTruthy();
    remounted.unmount();
  });

  it('the tip is gone on the next visit after an explicit dismissal', async () => {
    // The other half of the pair. Same round-tripping fake, opposite outcome --
    // which is what makes the test above evidence rather than a fake that only
    // ever says "not dismissed".
    useStatefulStorage();

    const first = render(<MorningPagesTip onBegin={mockOnBegin} />);
    await first.findByTestId('journal-morning-pages-tip');
    await act(async () => {
      fireEvent.press(first.getByTestId('journal-morning-pages-dismiss'));
    });
    first.unmount();

    const remounted = render(<MorningPagesTip onBegin={mockOnBegin} />);
    await waitFor(() => expect(remounted.queryByTestId('journal-morning-pages-tip')).toBeNull());
    remounted.unmount();
  });

  it('renders no streak or shame copy anywhere in the band', async () => {
    const view = render(<MorningPagesTip onBegin={mockOnBegin} />);
    await view.findByTestId('journal-morning-pages-tip');

    const json = view.toJSON() as unknown as RenderedNode | RenderedNode[] | null;
    let roots: RenderedNode[] = [];
    if (Array.isArray(json)) {
      roots = json;
    } else if (json !== null) {
      roots = [json];
    }
    const strings = roots.flatMap((root) => collectRenderedStrings(root));

    expect(strings.length).toBeGreaterThan(0);
    for (const copy of strings) {
      expect(ranksOrShames(copy)).toBe(false);
    }
    expect(view.queryByText(/streak/i)).toBeNull();
  });
});
