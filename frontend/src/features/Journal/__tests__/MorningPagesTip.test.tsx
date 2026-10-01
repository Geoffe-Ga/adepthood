/* eslint-env jest */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import { X } from 'lucide-react-native';
import React from 'react';
import { StyleSheet } from 'react-native';
import type { TextStyle, ViewStyle } from 'react-native';

import {
  MORNING_PAGES_CARD_COPY_ENTRIES,
  MORNING_PAGES_CTA,
  MORNING_PAGES_DISMISS_A11Y,
  MORNING_PAGES_NEVER_A11Y,
  MORNING_PAGES_NEVER_LINK,
  MORNING_PAGES_TITLE_SUFFIX,
  morningPageTitle,
} from '../morningPagesCopy';
import { CLOSE_ICON_SIZE, closeCornerReserve } from '../ReflectionDismiss';

import { INTERACTIVE_TEXT_MIN, SPACING, ink, touchTarget } from '@/design/tokens';
import { ranksOrShames } from '@/features/Map/__tests__/copyIntentRule';

/** The persisted shape `morningPagesTipStorage` hands back. */
interface TipState {
  setAsideOn: string | null;
  neverOffer: boolean;
}

const OPEN: TipState = { setAsideOn: null, neverOffer: false };

const mockLoad = jest.fn() as jest.MockedFunction<() => Promise<TipState>>;
const mockSaveSetAside = jest.fn() as jest.MockedFunction<(_day: string) => Promise<void>>;
const mockSaveNever = jest.fn() as jest.MockedFunction<(_value: boolean) => Promise<void>>;
const mockOnBegin = jest.fn();
const mockOnDismissed = jest.fn();
let mockUserTimezone = 'America/Los_Angeles';

jest.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ userTimezone: mockUserTimezone }),
}));

jest.mock('@/storage/morningPagesTipStorage', () => ({
  loadMorningPagesTipState: (...a: unknown[]) =>
    (mockLoad as unknown as (...x: unknown[]) => unknown)(...a),
  saveMorningPagesTipSetAside: (...a: unknown[]) =>
    (mockSaveSetAside as unknown as (...x: unknown[]) => unknown)(...a),
  saveMorningPagesTipNeverOffer: (...a: unknown[]) =>
    (mockSaveNever as unknown as (...x: unknown[]) => unknown)(...a),
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
  mockSaveSetAside.mockReset();
  mockSaveNever.mockReset();
  mockOnBegin.mockReset();
  mockOnDismissed.mockReset();
  mockLoad.mockResolvedValue(OPEN);
  mockSaveSetAside.mockResolvedValue(undefined);
  mockSaveNever.mockResolvedValue(undefined);
  mockUserTimezone = 'America/Los_Angeles';
});

afterEach(() => {
  jest.useRealTimers();
});

/**
 * Swap the flat mocks for a fake that actually remembers what was written.
 *
 * The default `mockLoad` answers the open state unconditionally, which is fine
 * for the single-render tests but useless for anything about a *later* visit: a
 * remount would report "offered" however the component behaved. Tests that turn
 * on persistence call this so their assertions depend on the write.
 */
function useStatefulStorage(): void {
  let stored: TipState = { ...OPEN };
  mockLoad.mockImplementation(() => Promise.resolve({ ...stored }));
  mockSaveSetAside.mockImplementation((day: string) => {
    stored = { ...stored, setAsideOn: day };
    return Promise.resolve();
  });
  mockSaveNever.mockImplementation((value: boolean) => {
    stored = { ...stored, neverOffer: value };
    return Promise.resolve();
  });
}

/**
 * Freeze the clock at `instant`. `nextTick` and `setImmediate` stay real so the
 * storage promises and RNTL's `waitFor` still settle.
 */
function freezeClockAt(instant: string): void {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  jest.setSystemTime(new Date(instant));
}

/** 2026-09-10 23:30 in Los Angeles; already 2026-09-11 in UTC. */
const LA_LATE_EVENING = '2026-09-11T06:30:00.000Z';
/** 2026-09-11 01:00 in Los Angeles: the next day there. */
const LA_NEXT_DAY = '2026-09-11T08:00:00.000Z';

describe('MorningPagesTip', () => {
  it('renders the tip when nothing has set it aside', async () => {
    const { findByTestId } = render(<MorningPagesTip onBegin={mockOnBegin} />);
    expect(await findByTestId('journal-morning-pages-tip')).toBeTruthy();
  });

  it('renders nothing once the writer asked never to be offered it again', async () => {
    mockLoad.mockResolvedValue({ setAsideOn: null, neverOffer: true });
    const { queryByTestId } = render(<MorningPagesTip onBegin={mockOnBegin} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(queryByTestId('journal-morning-pages-band')).toBeNull();
    expect(mockLoad).toHaveBeenCalledTimes(1);
  });

  it('renders nothing on the day it was set aside, in the writer’s time zone', async () => {
    freezeClockAt(LA_LATE_EVENING);
    mockLoad.mockResolvedValue({ setAsideOn: '2026-09-10', neverOffer: false });
    const { queryByTestId } = render(<MorningPagesTip onBegin={mockOnBegin} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(queryByTestId('journal-morning-pages-band')).toBeNull();
    expect(mockLoad).toHaveBeenCalledTimes(1);
  });

  it('renders the tip when it was only set aside on an earlier day', async () => {
    freezeClockAt(LA_NEXT_DAY);
    mockLoad.mockResolvedValue({ setAsideOn: '2026-09-10', neverOffer: false });
    const { findByTestId } = render(<MorningPagesTip onBegin={mockOnBegin} />);
    expect(await findByTestId('journal-morning-pages-tip')).toBeTruthy();
  });

  it('renders nothing while the persisted state is still loading, so the tip never flashes', () => {
    mockLoad.mockImplementation(() => new Promise<TipState>(() => undefined));
    const { queryByTestId } = render(<MorningPagesTip onBegin={mockOnBegin} />);
    expect(queryByTestId('journal-morning-pages-tip')).toBeNull();
  });

  it('the X sets the tip aside for today only, and hides the band without invoking onBegin', async () => {
    freezeClockAt(LA_LATE_EVENING);
    const { findByTestId, getByTestId, queryByTestId } = render(
      <MorningPagesTip onBegin={mockOnBegin} />,
    );
    await findByTestId('journal-morning-pages-tip');

    await act(async () => {
      fireEvent.press(getByTestId('journal-morning-pages-dismiss'));
    });

    // Today in Los Angeles, not the UTC date the instant already carries.
    expect(mockSaveSetAside).toHaveBeenCalledTimes(1);
    expect(mockSaveSetAside).toHaveBeenCalledWith('2026-09-10');
    expect(mockSaveNever).not.toHaveBeenCalled();
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
    // legible here. Taking up the invitation is the opposite of declining it --
    // for today or for good.
    expect(mockSaveSetAside).not.toHaveBeenCalled();
    expect(mockSaveNever).not.toHaveBeenCalled();
    expect(queryByTestId('journal-morning-pages-tip')).not.toBeNull();
  });

  it('the tip is still there on the next visit after beginning a page', async () => {
    // The criterion is about the *next* shelf visit, not just the press: a
    // component that skipped the write but still set local state would satisfy
    // the test above and still hide the tip for the rest of the session.
    //
    // The default mocks cannot show that. `mockLoad` is pinned to the open
    // state in `beforeEach`, so a remount reports "offered" no matter what was
    // written -- the assertion would hold even if the CTA still persisted.
    // So this drives a fake that actually round-trips, and the sibling test
    // below sets the tip aside through the same fake to prove it can hide it.
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

  it('the tip is gone on a same-day visit after the X', async () => {
    // The other half of the pair. Same round-tripping fake, opposite outcome --
    // which is what makes the test above evidence rather than a fake that only
    // ever says "offered".
    useStatefulStorage();

    const first = render(<MorningPagesTip onBegin={mockOnBegin} />);
    await first.findByTestId('journal-morning-pages-tip');
    await act(async () => {
      fireEvent.press(first.getByTestId('journal-morning-pages-dismiss'));
    });
    first.unmount();

    const remounted = render(<MorningPagesTip onBegin={mockOnBegin} />);
    await waitFor(() => expect(mockLoad).toHaveBeenCalledTimes(2));
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

describe('MorningPagesTip — set aside for today, back tomorrow (#3005)', () => {
  it('after the corner X, the tip returns on the next day in the writer’s time zone', async () => {
    useStatefulStorage();
    freezeClockAt(LA_LATE_EVENING);

    const first = render(<MorningPagesTip onBegin={mockOnBegin} />);
    await first.findByTestId('journal-morning-pages-tip');
    await act(async () => {
      fireEvent.press(first.getByTestId('journal-morning-pages-dismiss'));
    });
    expect(mockSaveSetAside).toHaveBeenCalledWith('2026-09-10');
    first.unmount();

    const sameDay = render(<MorningPagesTip onBegin={mockOnBegin} />);
    await waitFor(() => expect(mockLoad).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(sameDay.queryByTestId('journal-morning-pages-band')).toBeNull());
    sameDay.unmount();

    jest.setSystemTime(new Date(LA_NEXT_DAY));
    const nextDay = render(<MorningPagesTip onBegin={mockOnBegin} />);
    expect(await nextDay.findByTestId('journal-morning-pages-tip')).toBeTruthy();
    nextDay.unmount();
  });

  it('stays hidden at 23:59 in Los Angeles, though UTC has already rolled over', async () => {
    useStatefulStorage();
    // 2026-09-10 20:00 in Los Angeles; 2026-09-11 03:00 in UTC.
    freezeClockAt('2026-09-11T03:00:00.000Z');

    const first = render(<MorningPagesTip onBegin={mockOnBegin} />);
    await first.findByTestId('journal-morning-pages-tip');
    await act(async () => {
      fireEvent.press(first.getByTestId('journal-morning-pages-dismiss'));
    });
    expect(mockSaveSetAside).toHaveBeenCalledWith('2026-09-10');
    first.unmount();

    // 23:59 the same evening in Los Angeles.
    jest.setSystemTime(new Date('2026-09-11T06:59:00.000Z'));
    const lateSameDay = render(<MorningPagesTip onBegin={mockOnBegin} />);
    await waitFor(() => expect(mockLoad).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(lateSameDay.queryByTestId('journal-morning-pages-band')).toBeNull());
    lateSameDay.unmount();

    // One minute later it is the next day there, and the tip is back.
    jest.setSystemTime(new Date('2026-09-11T07:00:00.000Z'));
    const midnight = render(<MorningPagesTip onBegin={mockOnBegin} />);
    expect(await midnight.findByTestId('journal-morning-pages-tip')).toBeTruthy();
    midnight.unmount();
  });

  it('re-reads the stored state when the host’s refreshKey changes', async () => {
    useStatefulStorage();
    const view = render(<MorningPagesTip onBegin={mockOnBegin} refreshKey={1} />);
    await view.findByTestId('journal-morning-pages-tip');
    expect(mockLoad).toHaveBeenCalledTimes(1);

    view.rerender(<MorningPagesTip onBegin={mockOnBegin} refreshKey={1} />);
    expect(mockLoad).toHaveBeenCalledTimes(1);

    view.rerender(<MorningPagesTip onBegin={mockOnBegin} refreshKey={2} />);
    await waitFor(() => expect(mockLoad).toHaveBeenCalledTimes(2));
    expect(view.getByTestId('journal-morning-pages-tip')).toBeTruthy();
  });

  it('a refresh brings the tip back once the stored decline is cleared elsewhere', async () => {
    mockLoad.mockResolvedValue({ setAsideOn: null, neverOffer: true });
    const view = render(<MorningPagesTip onBegin={mockOnBegin} refreshKey={1} />);
    await waitFor(() => expect(mockLoad).toHaveBeenCalledTimes(1));
    expect(view.queryByTestId('journal-morning-pages-band')).toBeNull();

    // Settings → "Offer morning pages again" cleared it while the shelf stayed mounted.
    mockLoad.mockResolvedValue(OPEN);
    view.rerender(<MorningPagesTip onBegin={mockOnBegin} refreshKey={2} />);
    expect(await view.findByTestId('journal-morning-pages-tip')).toBeTruthy();
  });

  it('a read that started before the X cannot bring the tip back when it lands', async () => {
    const view = render(<MorningPagesTip onBegin={mockOnBegin} refreshKey={1} />);
    await view.findByTestId('journal-morning-pages-tip');

    // A focus-driven re-read is in flight, holding the pre-press record...
    let land: (state: TipState) => void = () => undefined;
    mockLoad.mockImplementation(
      () =>
        new Promise<TipState>((resolve) => {
          land = resolve;
        }),
    );
    view.rerender(<MorningPagesTip onBegin={mockOnBegin} refreshKey={2} />);
    await waitFor(() => expect(mockLoad).toHaveBeenCalledTimes(2));

    // ...the writer sets the tip aside...
    await act(async () => {
      fireEvent.press(view.getByTestId('journal-morning-pages-dismiss'));
    });
    expect(view.queryByTestId('journal-morning-pages-band')).toBeNull();

    // ...and the stale read lands. The decline holds.
    await act(async () => {
      land(OPEN);
      await Promise.resolve();
    });
    expect(view.queryByTestId('journal-morning-pages-band')).toBeNull();
  });
});

describe('MorningPagesTip — "Don’t show this again" (#3005)', () => {
  it('is a quiet in-card link, named by the words it shows', async () => {
    const view = render(<MorningPagesTip onBegin={mockOnBegin} />);
    await view.findByTestId('journal-morning-pages-tip');

    const never = view.getByTestId('journal-morning-pages-never');
    expect(never.props.accessibilityRole).toBe('button');
    expect(never.props.accessibilityLabel).toBe(MORNING_PAGES_NEVER_A11Y);
    expect(within(never).getByText(MORNING_PAGES_NEVER_LINK)).toBeTruthy();
    expect(String(never.props.accessibilityLabel).startsWith(MORNING_PAGES_NEVER_LINK)).toBe(true);
    const band = view.getByTestId('journal-morning-pages-band');
    expect(within(band).getByTestId('journal-morning-pages-never')).toBe(never);
  });

  it('sits at the interactive text floor in soft ink, 44 high, clear of the corner X', async () => {
    const view = render(<MorningPagesTip onBegin={mockOnBegin} />);
    await view.findByTestId('journal-morning-pages-tip');

    const never = view.getByTestId('journal-morning-pages-never');
    const area = flatStyle(never);
    expect(area.minHeight).toBeGreaterThanOrEqual(touchTarget.minimum);
    expect(area.marginRight).toBe(closeCornerReserve(SPACING.lg));
    expect(area.alignSelf).toBe('flex-start');

    const text = StyleSheet.flatten(
      within(never).getByText(MORNING_PAGES_NEVER_LINK).props.style as TextStyle,
    );
    expect(text.fontSize).toBe(INTERACTIVE_TEXT_MIN);
    expect(text.color).toBe(ink.soft);
    // Quieter than "Begin a page": the body weight, not the action's bold.
    expect(text.fontWeight).toBe('400');
  });

  it('retires the tip for good, persisting before it hands focus on, and never sets it aside', async () => {
    const order: string[] = [];
    mockSaveNever.mockImplementation(() => {
      order.push('never');
      return Promise.resolve();
    });
    mockOnDismissed.mockImplementation(() => {
      order.push('dismissed');
    });
    const view = render(<MorningPagesTip onBegin={mockOnBegin} onDismissed={mockOnDismissed} />);
    await view.findByTestId('journal-morning-pages-tip');

    await act(async () => {
      fireEvent.press(view.getByTestId('journal-morning-pages-never'));
    });

    expect(mockSaveNever).toHaveBeenCalledTimes(1);
    expect(mockSaveNever).toHaveBeenCalledWith(true);
    expect(mockSaveSetAside).not.toHaveBeenCalled();
    expect(mockOnBegin).not.toHaveBeenCalled();
    expect(mockOnDismissed).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['never', 'dismissed']);
    expect(view.queryByTestId('journal-morning-pages-band')).toBeNull();
  });

  it('stays gone on later days', async () => {
    useStatefulStorage();
    freezeClockAt(LA_LATE_EVENING);

    const first = render(<MorningPagesTip onBegin={mockOnBegin} />);
    await first.findByTestId('journal-morning-pages-tip');
    await act(async () => {
      fireEvent.press(first.getByTestId('journal-morning-pages-never'));
    });
    first.unmount();

    // A week later in Los Angeles.
    jest.setSystemTime(new Date('2026-09-18T08:00:00.000Z'));
    const later = render(<MorningPagesTip onBegin={mockOnBegin} />);
    await waitFor(() => expect(mockLoad).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(later.queryByTestId('journal-morning-pages-band')).toBeNull());
    later.unmount();
  });
});

describe('MorningPagesTip — the decline is a corner X (#2860)', () => {
  it("declines with an icon-only X pinned in the band's top-right corner, after the card's text actions", async () => {
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
    expect(childIds).toEqual([
      'journal-morning-pages-tip',
      'journal-morning-pages-never',
      'journal-morning-pages-dismiss',
    ]);

    const textActions = within(band)
      .getAllByRole('button')
      .filter((button) => within(button).queryAllByText(/.+/).length > 0);
    expect(textActions.map((button) => button.props.testID)).toEqual([
      'journal-morning-pages-tip',
      'journal-morning-pages-never',
    ]);
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

  it('calls onDismissed once, after persisting the set-aside — never on begin', async () => {
    const order: string[] = [];
    mockSaveSetAside.mockImplementation(() => {
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
    for (const entry of MORNING_PAGES_CARD_COPY_ENTRIES) {
      // The suffix is only ever shown inside the dated title a begun page carries.
      if (entry === MORNING_PAGES_TITLE_SUFFIX) continue;
      expect(strings).toContain(entry);
    }
  });
});
