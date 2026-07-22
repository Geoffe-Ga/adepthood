/* eslint-env jest */
// RED: `MorningPagesTip` does not exist yet; `require('../MorningPagesTip')` throws until it does.
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

  it('the CTA calls onBegin, persists true, and hides the band', async () => {
    const { findByTestId, getByTestId, queryByTestId } = render(
      <MorningPagesTip onBegin={mockOnBegin} />,
    );
    await findByTestId('journal-morning-pages-tip');

    await act(async () => {
      fireEvent.press(getByTestId('journal-morning-pages-tip'));
    });

    expect(mockOnBegin).toHaveBeenCalledTimes(1);
    expect(mockSave).toHaveBeenCalledWith(true);
    await waitFor(() => expect(queryByTestId('journal-morning-pages-tip')).toBeNull());
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
