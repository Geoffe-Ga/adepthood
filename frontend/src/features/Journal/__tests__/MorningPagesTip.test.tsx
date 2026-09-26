/* eslint-env jest */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import { X } from 'lucide-react-native';
import React from 'react';
import { StyleSheet } from 'react-native';
import type { ViewStyle } from 'react-native';

import {
  MORNING_PAGES_COPY_ENTRIES,
  MORNING_PAGES_CTA,
  MORNING_PAGES_DISMISS_A11Y,
  MORNING_PAGES_TITLE_SUFFIX,
  morningPageTitle,
} from '../morningPagesCopy';
import { CLOSE_ICON_SIZE } from '../ReflectionDismiss';

import { SPACING, ink, touchTarget } from '@/design/tokens';
import { ranksOrShames } from '@/features/Map/__tests__/copyIntentRule';

const mockLoad = jest.fn() as jest.MockedFunction<() => Promise<boolean>>;
const mockSave = jest.fn() as jest.MockedFunction<(_v: boolean) => Promise<void>>;
const mockOnBegin = jest.fn();
const mockOnDismissed = jest.fn();
let mockUserTimezone = 'America/Los_Angeles';

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ userTimezone: mockUserTimezone }),
}));

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

/** A rendered host node, as RNTL's queries hand it back. */
type HostNode = ReturnType<ReturnType<typeof render>['getByTestId']>;

function flatStyle(node: { props: { style?: unknown } }): ViewStyle {
  return (StyleSheet.flatten(node.props.style as ViewStyle) ?? {}) as ViewStyle;
}

/** Every string the rendered tree carries, visible text and accessibility labels alike. */
function renderedStrings(view: ReturnType<typeof render>): string[] {
  const json = view.toJSON() as unknown as RenderedNode | RenderedNode[] | null;
  if (json === null) return [];
  const roots = Array.isArray(json) ? json : [json];
  return roots.flatMap((root) => collectRenderedStrings(root));
}

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
  mockOnDismissed.mockReset();
  mockLoad.mockResolvedValue(false);
  mockSave.mockResolvedValue(undefined);
  mockUserTimezone = 'America/Los_Angeles';
});

afterEach(() => {
  jest.useRealTimers();
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

  it('the CTA supplies today’s sortable Daily Journal title in the writer’s time zone', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-11T01:00:00.000Z'));
    const { findByTestId, getByTestId, queryByTestId } = render(
      <MorningPagesTip onBegin={mockOnBegin} />,
    );
    await findByTestId('journal-morning-pages-tip');

    await act(async () => {
      fireEvent.press(getByTestId('journal-morning-pages-tip'));
    });

    expect(mockOnBegin).toHaveBeenCalledTimes(1);
    expect(mockOnBegin).toHaveBeenCalledWith(morningPageTitle('2026-09-10'));
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

    const strings = renderedStrings(view);

    expect(strings.length).toBeGreaterThan(0);
    for (const copy of strings) {
      expect(ranksOrShames(copy)).toBe(false);
    }
    expect(view.queryByText(/streak/i)).toBeNull();
  });
});

describe('MorningPagesTip — the decline is a corner X (#2860)', () => {
  it("declines with an icon-only X pinned in the band's top-right corner, leaving 'Begin a page' as the only text action", async () => {
    const view = render(<MorningPagesTip onBegin={mockOnBegin} />);
    await view.findByTestId('journal-morning-pages-tip');

    expect(view.queryByText('Not now')).toBeNull();

    const dismiss = view.getByTestId('journal-morning-pages-dismiss');
    expect(dismiss.props.accessibilityRole).toBe('button');
    expect(dismiss.props.accessibilityLabel).toBe(MORNING_PAGES_DISMISS_A11Y);
    expect(within(dismiss).queryAllByText(/.+/)).toHaveLength(0);

    const icons = view.UNSAFE_getAllByType(X);
    expect(icons).toHaveLength(1);
    expect(icons[0]?.props.size).toBe(CLOSE_ICON_SIZE);
    expect(icons[0]?.props.color).toBe(ink.soft);

    const corner = flatStyle(dismiss);
    expect(corner).toMatchObject({ position: 'absolute', top: 0, right: 0 });
    expect(corner.minWidth).toBeGreaterThanOrEqual(touchTarget.minimum);
    expect(corner.minHeight).toBeGreaterThanOrEqual(touchTarget.minimum);

    // Inside the card's box, and last, so a screen reader meets the invitation first.
    const band = view.getByTestId('journal-morning-pages-band');
    expect(within(band).getByTestId('journal-morning-pages-dismiss')).toBe(dismiss);
    const childIds = band.children.map((child: HostNode | string) =>
      typeof child === 'string' ? child : child.props.testID,
    );
    expect(childIds).toEqual(['journal-morning-pages-tip', 'journal-morning-pages-dismiss']);

    const textActions = within(band)
      .getAllByRole('button')
      .filter((button) => within(button).queryAllByText(/.+/).length > 0);
    expect(textActions.map((button) => button.props.testID)).toEqual(['journal-morning-pages-tip']);
    expect(within(textActions[0]!).getByText('Begin a page')).toBeTruthy();
  });

  it('names the begin button by the words it shows, so a voice user can say them (WCAG 2.5.3)', async () => {
    const view = render(<MorningPagesTip onBegin={mockOnBegin} />);
    const begin = await view.findByTestId('journal-morning-pages-tip');
    expect(within(begin).getByText(MORNING_PAGES_CTA)).toBeTruthy();
    expect(String(begin.props.accessibilityLabel).startsWith(MORNING_PAGES_CTA)).toBe(true);
  });

  it('keeps the begin area clear of the corner X', async () => {
    const view = render(<MorningPagesTip onBegin={mockOnBegin} />);
    const begin = await view.findByTestId('journal-morning-pages-tip');
    const band = flatStyle(view.getByTestId('journal-morning-pages-band'));
    expect(band.padding).toBe(SPACING.lg);
    expect(flatStyle(begin).marginRight).toBe(touchTarget.minimum - SPACING.lg);
  });

  it('calls onDismissed once, after persisting the decline — never on begin', async () => {
    const order: string[] = [];
    mockSave.mockImplementation(() => {
      order.push('save');
      return Promise.resolve();
    });
    mockOnDismissed.mockImplementation(() => {
      order.push('dismissed');
    });

    const begun = render(<MorningPagesTip onBegin={mockOnBegin} onDismissed={mockOnDismissed} />);
    const begin = await begun.findByTestId('journal-morning-pages-tip');
    await act(async () => {
      fireEvent.press(begin);
    });
    expect(mockOnDismissed).not.toHaveBeenCalled();
    begun.unmount();

    const declined = render(
      <MorningPagesTip onBegin={mockOnBegin} onDismissed={mockOnDismissed} />,
    );
    await declined.findByTestId('journal-morning-pages-tip');
    await act(async () => {
      fireEvent.press(declined.getByTestId('journal-morning-pages-dismiss'));
    });
    expect(mockOnDismissed).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['save', 'dismissed']);
  });

  it('renders every string its copy sweep lists, so the sweep never vouches for unshown copy', async () => {
    // A guard, not a red test: it passes before and after #2860. It exists so
    // that retiring the visible "Not now" also retires it from the sweep list.
    const view = render(<MorningPagesTip onBegin={mockOnBegin} />);
    await view.findByTestId('journal-morning-pages-tip');
    const strings = renderedStrings(view);
    for (const entry of MORNING_PAGES_COPY_ENTRIES) {
      // The suffix is only ever shown inside the dated title a begun page carries.
      if (entry === MORNING_PAGES_TITLE_SUFFIX) continue;
      expect(strings).toContain(entry);
    }
  });
});
