/* eslint-env jest */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

/**
 * The first "Promote a quote" explains what promotion is before it asks for a
 * passage (#2864).
 *
 * These specs render the real screen over the real promote-explainer storage
 * (the jest AsyncStorage stand-in underneath it), so the dismissal they assert
 * is the one the next mount reads back — under this account's key, not a
 * device-wide one. The race between a press and the stored read is pinned in
 * ``usePromoteExplainer.test.tsx``, where the read can be held open.
 */
import { PROMOTED_NOTICE_MS } from '../usePromotions';

import type { JournalMessage, PromotedQuote } from '@/api';
import { setActiveUser } from '@/storage/userScope';

const mockGet = jest.fn() as jest.MockedFunction<(_id: number) => Promise<JournalMessage>>;
const mockPromote = jest.fn() as jest.MockedFunction<
  (_entryId: number, _span: { anchor_start: number; anchor_end: number }) => Promise<PromotedQuote>
>;

jest.mock('@/context/AuthContext', () => require('./authContextTestKit'));

jest.mock('@/api', () => ({
  journal: {
    get: (...a: unknown[]) => (mockGet as unknown as (...x: unknown[]) => unknown)(...a),
    create: jest.fn(),
    update: jest.fn(),
  },
  prompts: { respond: jest.fn() },
  resonance: { list: () => Promise.resolve({ items: [] }), generate: jest.fn() },
  completionSuggestions: {
    list: () => Promise.resolve({ items: [] }),
    accept: jest.fn(),
    dismiss: jest.fn(),
  },
  promotions: {
    create: (...a: unknown[]) => (mockPromote as unknown as (...x: unknown[]) => unknown)(...a),
    remove: jest.fn(),
    setIncluded: jest.fn(),
    list: () => Promise.resolve([]),
  },
}));

jest.mock('@/navigation/hooks', () => ({
  ...(jest.requireActual('@/navigation/hooks') as Record<string, unknown>),
  useAppNavigation: () => ({ navigate: jest.fn(), setOptions: jest.fn() }),
}));

jest.mock('@/context/ApiKeyContext', () => require('./apiKeyContextTestKit'));

const JournalEntryScreen = require('../JournalEntryScreen').default;

const BODY = 'A page about a daily run to the river and back.';
const ACCOUNT = 1;
const DISMISSED_KEY = `@adepthood/promote_explainer_dismissed#u${ACCOUNT}`;

function entry(): JournalMessage {
  return {
    id: 7,
    message: BODY,
    sender: 'user',
    timestamp: '2026-06-01T00:00:00Z',
    tag: 'freeform' as JournalMessage['tag'],
    practice_session_id: null,
    user_practice_id: null,
    title: 'Runs',
    status: 'finished',
    updated_at: '2026-06-01T00:00:00Z',
  };
}

function renderScreen() {
  const route = { key: 'k', name: 'JournalEntry' as const, params: { entryId: 7 } };
  const navigation = { navigate: jest.fn(), goBack: jest.fn(), push: jest.fn() };
  const Screen = JournalEntryScreen as unknown as React.ComponentType<Record<string, unknown>>;
  return render(<Screen navigation={navigation} route={route} />);
}

type Screen = ReturnType<typeof renderScreen>;

async function pressPromote(screen: Screen): Promise<void> {
  const button = await screen.findByTestId('promote-quote-button');
  await act(async () => {
    fireEvent.press(button);
  });
}

beforeEach(async () => {
  await AsyncStorage.clear();
  setActiveUser(ACCOUNT);
  mockGet.mockReset();
  mockGet.mockResolvedValue(entry());
  mockPromote.mockReset();
});

afterEach(() => {
  setActiveUser(null);
});

describe('JournalEntryScreen — the first promote explains itself', () => {
  it('opens the promote explainer on the first "Promote a quote" tap and does not start selection', async () => {
    const screen = renderScreen();
    await pressPromote(screen);

    expect(await screen.findByTestId('promote-explainer-dialog')).toBeTruthy();
    expect(screen.getByRole('header', { name: 'Promote a quote' })).toBeTruthy();
    const body = screen.getByTestId('promote-explainer-body').props.children as string;
    expect(body).toMatch(/your next review/);
    expect(body).toMatch(/Promoted quotes in the Journal menu/);
    const tick = screen.getByTestId('promote-explainer-dont-show');
    expect(tick.props.accessibilityRole).toBe('checkbox');
    expect(tick.props.accessibilityState.checked).toBe(false);
    expect(screen.queryByTestId('quote-select-input')).toBeNull();
  });

  it('"Choose the passage" closes the explainer and starts selecting', async () => {
    const screen = renderScreen();
    await pressPromote(screen);
    fireEvent.press(await screen.findByTestId('promote-explainer-continue'));

    expect(screen.queryByTestId('promote-explainer-dialog')).toBeNull();
    expect(screen.getByTestId('quote-select-input').props.value).toBe(BODY);
  });

  it('"Not now" leaves the page as it was and remembers nothing', async () => {
    const screen = renderScreen();
    await pressPromote(screen);
    fireEvent.press(await screen.findByTestId('promote-explainer-cancel'));

    expect(screen.queryByTestId('promote-explainer-dialog')).toBeNull();
    expect(screen.queryByTestId('quote-select-input')).toBeNull();
    expect(screen.getByTestId('journal-read-actions')).toBeTruthy();
    expect(await AsyncStorage.getItem(DISMISSED_KEY)).toBeNull();

    // Declining without the tick keeps the note: the next tap explains again.
    await pressPromote(screen);
    expect(await screen.findByTestId('promote-explainer-dialog')).toBeTruthy();
  });

  it('the scrim declines exactly like "Not now"', async () => {
    const screen = renderScreen();
    await pressPromote(screen);
    fireEvent.press(await screen.findByTestId('promote-explainer-scrim'));

    expect(screen.queryByTestId('promote-explainer-dialog')).toBeNull();
    expect(screen.queryByTestId('quote-select-input')).toBeNull();
  });
});

describe('JournalEntryScreen — "Don’t show this again" is remembered per account', () => {
  it('ticked, then continued: stored under this account, and the next tap goes straight to selecting', async () => {
    const screen = renderScreen();
    await pressPromote(screen);
    fireEvent.press(await screen.findByTestId('promote-explainer-dont-show'));
    fireEvent.press(screen.getByTestId('promote-explainer-continue'));

    await waitFor(async () => expect(await AsyncStorage.getItem(DISMISSED_KEY)).toBe('true'));
    fireEvent.press(screen.getByTestId('quote-select-cancel'));

    await pressPromote(screen);
    expect(screen.queryByTestId('promote-explainer-dialog')).toBeNull();
    expect(screen.getByTestId('quote-select-input')).toBeTruthy();
  });

  it('ticked, then declined: the dismissal still holds, and survives a remount', async () => {
    const first = renderScreen();
    await pressPromote(first);
    fireEvent.press(await first.findByTestId('promote-explainer-dont-show'));
    fireEvent.press(first.getByTestId('promote-explainer-cancel'));
    expect(first.queryByTestId('quote-select-input')).toBeNull();
    await waitFor(async () => expect(await AsyncStorage.getItem(DISMISSED_KEY)).toBe('true'));
    first.unmount();

    const second = renderScreen();
    await pressPromote(second);
    expect(second.queryByTestId('promote-explainer-dialog')).toBeNull();
    expect(second.getByTestId('quote-select-input')).toBeTruthy();
  });

  it('another account on the same device is still shown the explainer', async () => {
    await AsyncStorage.setItem(DISMISSED_KEY, 'true');
    setActiveUser(ACCOUNT + 1);

    const screen = renderScreen();
    await pressPromote(screen);
    expect(await screen.findByTestId('promote-explainer-dialog')).toBeTruthy();
  });
});

describe('JournalEntryScreen — the Promoted notice names where the quote went', () => {
  it('announces "Promoted — waiting for your next review" politely, then clears', async () => {
    await AsyncStorage.setItem(DISMISSED_KEY, 'true');
    mockPromote.mockResolvedValue({
      id: 90,
      source_entry_id: 7,
      anchor_start: 2,
      anchor_end: 19,
      anchor_text: Array.from(BODY).slice(2, 19).join(''),
      pending: true,
      stale: false,
    });
    const announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => undefined);
    const screen = renderScreen();
    await pressPromote(screen);
    fireEvent(screen.getByTestId('quote-select-input'), 'selectionChange', {
      nativeEvent: { selection: { start: 2, end: 19 } },
    });

    jest.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.press(screen.getByTestId('quote-select-confirm'));
      });
      const notice = screen.getByTestId('quote-promotion-success');
      expect(notice).toHaveTextContent('Promoted — waiting for your next review');
      expect(notice.props.accessibilityLiveRegion).toBe('polite');
      // VoiceOver ignores live regions, so iOS is told in words.
      expect(Platform.OS).toBe('ios');
      expect(announce).toHaveBeenCalledWith('Promoted — waiting for your next review');

      act(() => {
        jest.advanceTimersByTime(PROMOTED_NOTICE_MS);
      });
      expect(screen.queryByTestId('quote-promotion-success')).toBeNull();
    } finally {
      jest.useRealTimers();
      announce.mockRestore();
    }
  });
});
