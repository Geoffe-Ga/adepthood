import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import LinkHabitNudge from '../LinkHabitNudge';
import {
  LINK_HABIT_NUDGE_DECLINE,
  LINK_HABIT_NUDGE_DECLINE_A11Y,
  LINK_HABIT_NUDGE_PROMPT,
  LINK_HABIT_NUDGE_SETTINGS,
  LINK_HABIT_NUDGE_SETTINGS_A11Y,
} from '../saveAsHabitCopy';
import { toWritingSessionResult } from '../writingSession';
import WritingSessionBanner from '../WritingSessionBanner';

import { touchTarget } from '@/design/tokens';
import {
  loadLinkHabitNudgeDeclined,
  saveLinkHabitNudgeDeclined,
} from '@/storage/linkHabitNudgeStorage';
import { loadWritingOfferAnswered } from '@/storage/writingOfferStorage';
import { useWritingHabitLinkStore } from '@/store/useWritingHabitLinkStore';
import { moveAccessibilityFocus } from '@/utils/accessibilityFocus';

const mockNavigate = jest.fn();
const mockUseRootNavigation = jest.fn(() => ({ navigate: mockNavigate }));

jest.mock('@/navigation/hooks', () => ({
  useRootNavigation: () => mockUseRootNavigation(),
}));

jest.mock('@/api', () => ({
  uiFlags: {
    get: jest.fn(() => Promise.reject(new Error('not configured'))),
    update: jest.fn(() => Promise.reject(new Error('not configured'))),
  },
}));

jest.mock('@/storage/linkHabitNudgeStorage', () => ({
  loadLinkHabitNudgeDeclined: jest.fn(() => Promise.resolve(false)),
  saveLinkHabitNudgeDeclined: jest.fn(() => Promise.resolve(undefined)),
}));

jest.mock('@/storage/writingOfferStorage', () => ({
  loadWritingOfferAnswered: jest.fn(() => Promise.resolve(true)),
}));

jest.mock('@/utils/accessibilityFocus', () => ({ moveAccessibilityFocus: jest.fn() }));
const mockMoveFocus = jest.mocked(moveAccessibilityFocus);

const loadDeclined = loadLinkHabitNudgeDeclined as jest.Mock;
const saveDeclined = saveLinkHabitNudgeDeclined as jest.Mock;
const loadAnswered = loadWritingOfferAnswered as jest.Mock;

/** Let the mount-time flag reads land. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  loadDeclined.mockImplementation(() => Promise.resolve(false));
  loadAnswered.mockImplementation(() => Promise.resolve(true));
  useWritingHabitLinkStore.getState().reset();
  useWritingHabitLinkStore.setState({ habitId: null, hydrated: true });
});

describe('LinkHabitNudge — when it appears', () => {
  it('points an unlinked writer to Settings once the decline flag reads unset', async () => {
    const { findByTestId, getByText } = render(<LinkHabitNudge />);

    await findByTestId('link-habit-nudge');
    expect(getByText(LINK_HABIT_NUDGE_PROMPT)).toBeTruthy();
  });

  it('renders nothing, and never reaches for navigation, while the link is unknown', async () => {
    useWritingHabitLinkStore.setState({ habitId: null, hydrated: false });
    const { queryByTestId } = render(<LinkHabitNudge />);
    await flush();

    expect(queryByTestId('link-habit-nudge')).toBeNull();
    // The gate holds no navigation: a page with no navigator must not throw.
    expect(mockUseRootNavigation).not.toHaveBeenCalled();
  });

  it('renders nothing when the server reports a linked habit, even with the flag unset', async () => {
    useWritingHabitLinkStore.setState({ habitId: 12, hydrated: true });
    const { queryByTestId } = render(<LinkHabitNudge />);
    await flush();

    expect(loadDeclined).toHaveBeenCalled();
    expect(queryByTestId('link-habit-nudge')).toBeNull();
  });

  it('goes away the moment a habit is linked', async () => {
    const { findByTestId, queryByTestId } = render(<LinkHabitNudge />);
    await findByTestId('link-habit-nudge');

    act(() => {
      useWritingHabitLinkStore.setState({ habitId: 12, hydrated: true });
    });

    expect(queryByTestId('link-habit-nudge')).toBeNull();
  });

  it('renders nothing while its flag read is still pending, so it never flashes', async () => {
    let finish: (_declined: boolean) => void = () => undefined;
    loadDeclined.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const { queryByTestId, findByTestId } = render(<LinkHabitNudge />);
    await flush();

    expect(queryByTestId('link-habit-nudge')).toBeNull();

    await act(async () => {
      finish(false);
    });
    await findByTestId('link-habit-nudge');
  });

  it('renders nothing once the writer has asked not to see it again', async () => {
    loadDeclined.mockImplementation(() => Promise.resolve(true));
    const { queryByTestId } = render(<LinkHabitNudge />);
    await flush();

    expect(queryByTestId('link-habit-nudge')).toBeNull();
  });
});

describe('LinkHabitNudge — beside the end-of-session offer', () => {
  it('does not read the offer flag on a page with no offer', async () => {
    const { findByTestId } = render(<LinkHabitNudge />);
    await findByTestId('link-habit-nudge');

    expect(loadAnswered).not.toHaveBeenCalled();
  });

  it('waits its turn while the offer is still unanswered: one invitation per note', async () => {
    loadAnswered.mockImplementation(() => Promise.resolve(false));
    const { queryByTestId } = render(<LinkHabitNudge waitForAnsweredOffer />);
    await flush();

    expect(loadAnswered).toHaveBeenCalledTimes(1);
    expect(queryByTestId('link-habit-nudge')).toBeNull();
  });

  it('appears once the offer has been answered', async () => {
    const { findByTestId } = render(<LinkHabitNudge waitForAnsweredOffer />);

    await findByTestId('link-habit-nudge');
  });
});

describe('LinkHabitNudge — its two actions', () => {
  it('has exactly two buttons, each at least the minimum touch target', async () => {
    const { findByTestId, getAllByRole, getByLabelText } = render(<LinkHabitNudge />);
    await findByTestId('link-habit-nudge');

    const buttons = getAllByRole('button');
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      const style = StyleSheet.flatten(button.props.style) as { minHeight?: number };
      expect(style.minHeight).toBeGreaterThanOrEqual(touchTarget.minimum);
    }
    expect(getByLabelText(LINK_HABIT_NUDGE_SETTINGS_A11Y)).toBeTruthy();
    expect(getByLabelText(LINK_HABIT_NUDGE_DECLINE_A11Y)).toBeTruthy();
  });

  it('opens Settings on the writing-habit row', async () => {
    const { findByTestId, getByText } = render(<LinkHabitNudge />);
    await findByTestId('link-habit-nudge');

    fireEvent.press(getByText(LINK_HABIT_NUDGE_SETTINGS));

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('Settings', { focus: 'writing-habit' });
  });

  it("hides at once and remembers when the writer chooses Don't show again", async () => {
    const { findByTestId, getByText, queryByTestId } = render(<LinkHabitNudge />);
    await findByTestId('link-habit-nudge');

    fireEvent.press(getByText(LINK_HABIT_NUDGE_DECLINE));

    expect(queryByTestId('link-habit-nudge')).toBeNull();
    expect(saveDeclined).toHaveBeenCalledTimes(1);
  });

  it('stays hidden on the next mount after a decline', async () => {
    const first = render(<LinkHabitNudge />);
    await first.findByTestId('link-habit-nudge');
    fireEvent.press(first.getByText(LINK_HABIT_NUDGE_DECLINE));
    first.unmount();
    // What the decline wrote is what the next note reads.
    loadDeclined.mockImplementation(() => Promise.resolve(saveDeclined.mock.calls.length > 0));

    const second = render(<LinkHabitNudge />);
    await flush();

    await waitFor(() => expect(loadDeclined).toHaveBeenCalledTimes(2));
    expect(second.queryByTestId('link-habit-nudge')).toBeNull();
  });
});

describe("LinkHabitNudge — where focus goes after Don't show again", () => {
  const FINISHED = toWritingSessionResult({ plannedMinutes: 20, elapsedMs: 20 * 60 * 1000 });

  it("hands focus to the note's Close rather than dropping it with the note", async () => {
    const { findByTestId, getByText, getByTestId } = render(
      <WritingSessionBanner result={FINISHED} onDismiss={jest.fn()}>
        <LinkHabitNudge />
      </WritingSessionBanner>,
    );
    await findByTestId('link-habit-nudge');
    expect(mockMoveFocus).not.toHaveBeenCalled();

    fireEvent.press(getByText(LINK_HABIT_NUDGE_DECLINE));

    expect(mockMoveFocus).toHaveBeenCalledTimes(1);
    const [target] = mockMoveFocus.mock.calls[0] ?? [];
    expect(target).not.toBeNull();
    expect((target as unknown as { props: { testID?: string } }).props.testID).toBe(
      'writing-session-banner-dismiss',
    );
    expect(getByTestId('writing-session-banner-dismiss')).toBeTruthy();
  });

  it('moves no focus when Go to Settings is pressed, which leaves the page', async () => {
    const { findByTestId, getByText } = render(
      <WritingSessionBanner result={FINISHED} onDismiss={jest.fn()}>
        <LinkHabitNudge />
      </WritingSessionBanner>,
    );
    await findByTestId('link-habit-nudge');

    fireEvent.press(getByText(LINK_HABIT_NUDGE_SETTINGS));

    expect(mockMoveFocus).not.toHaveBeenCalled();
  });

  it('still hides outside a banner, where there is nothing to hand focus to', async () => {
    const { findByTestId, getByText, queryByTestId } = render(<LinkHabitNudge />);
    await findByTestId('link-habit-nudge');

    fireEvent.press(getByText(LINK_HABIT_NUDGE_DECLINE));

    expect(queryByTestId('link-habit-nudge')).toBeNull();
    expect(mockMoveFocus).not.toHaveBeenCalled();
  });
});
