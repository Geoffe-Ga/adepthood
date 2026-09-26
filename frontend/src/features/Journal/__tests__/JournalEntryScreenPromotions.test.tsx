/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

// RED (select-a-span -> promote-quote, journal entry read mode): the screen
// does not yet render a "Promote a quote" affordance, a selection-mode
// TextInput, or promoted-quote spans -- every testID below is missing until
// the implementation-specialist wires `usePromotions` + the new affordance
// into `JournalEntryScreen`/`ReadColumn`.
import { parseJournalMarkdown, sourceToVisible, utf16ToSource } from '../journalMarkdown';
import { PROMOTED_NOTICE_MS } from '../usePromotions';

import type { JournalMessage, PromotedQuote } from '@/api';
import { touchTarget } from '@/design/tokens';

/** A never-settling promise plus its resolve, for pinning in-flight screen state. */
function deferredPromote(): {
  promise: Promise<PromotedQuote>;
  resolve: (_value: PromotedQuote) => void;
} {
  let resolve: (_value: PromotedQuote) => void = () => {};
  const promise = new Promise<PromotedQuote>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const mockGet = jest.fn() as jest.MockedFunction<(_id: number) => Promise<JournalMessage>>;
const mockCreate = jest.fn() as jest.MockedFunction<(_e: unknown) => Promise<JournalMessage>>;
const mockUpdate = jest.fn() as jest.MockedFunction<
  (_id: number, _p: unknown) => Promise<JournalMessage>
>;
const mockList = jest.fn() as jest.MockedFunction<(_id: number) => Promise<{ items: unknown[] }>>;
const mockCompletionList = jest.fn() as jest.MockedFunction<
  (_id: number) => Promise<{ items: unknown[] }>
>;
const mockPromote = jest.fn() as jest.MockedFunction<
  (_entryId: number, _span: { anchor_start: number; anchor_end: number }) => Promise<PromotedQuote>
>;
const mockRemovePromotion = jest.fn() as jest.MockedFunction<(_id: number) => Promise<void>>;
const mockPromotionsList = jest.fn() as jest.MockedFunction<
  (_entryId: number) => Promise<PromotedQuote[]>
>;

// ``useAuth`` throws outside a provider; the screen reads only the zone.
jest.mock('@/context/AuthContext', () => require('./authContextTestKit'));

jest.mock('@/api', () => ({
  journal: {
    get: (...a: unknown[]) => (mockGet as unknown as (...x: unknown[]) => unknown)(...a),
    create: (...a: unknown[]) => (mockCreate as unknown as (...x: unknown[]) => unknown)(...a),
    update: (...a: unknown[]) => (mockUpdate as unknown as (...x: unknown[]) => unknown)(...a),
  },
  prompts: { respond: jest.fn() },
  resonance: {
    list: (...a: unknown[]) => (mockList as unknown as (...x: unknown[]) => unknown)(...a),
    generate: jest.fn(),
  },
  completionSuggestions: {
    list: (...a: unknown[]) =>
      (mockCompletionList as unknown as (...x: unknown[]) => unknown)(...a),
    accept: jest.fn(),
    dismiss: jest.fn(),
  },
  promotions: {
    create: (...a: unknown[]) => (mockPromote as unknown as (...x: unknown[]) => unknown)(...a),
    remove: (...a: unknown[]) =>
      (mockRemovePromotion as unknown as (...x: unknown[]) => unknown)(...a),
    setIncluded: jest.fn(),
    list: (...a: unknown[]) =>
      (mockPromotionsList as unknown as (...x: unknown[]) => unknown)(...a),
  },
}));

jest.mock('@/navigation/hooks', () => ({
  ...(jest.requireActual('@/navigation/hooks') as Record<string, unknown>),
  useAppNavigation: () => ({ navigate: jest.fn(), setOptions: jest.fn() }),
}));

jest.mock('@/context/ApiKeyContext', () => require('./apiKeyContextTestKit'));

const JournalEntryScreen = require('../JournalEntryScreen').default;

const BODY = 'A page about a daily run to the river and back.';

function entry(overrides: Partial<JournalMessage> = {}): JournalMessage {
  return {
    id: 7,
    message: BODY,
    sender: 'user',
    timestamp: '2026-06-01T00:00:00Z',
    tag: 'freeform' as JournalMessage['tag'],
    practice_session_id: null,
    user_practice_id: null,
    title: 'Runs',
    status: 'finished', // read mode -- the surface this issue lives in
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

/**
 * A promoted quote over BODY whose ``anchor_text`` is the slice its offsets
 * address, edge-trimmed as the server snapshots it (read mode draws a quote
 * only where its offsets still spell its text).
 */
function promotedQuote(overrides: Partial<PromotedQuote> = {}): PromotedQuote {
  const start = overrides.anchor_start ?? 2;
  const end = overrides.anchor_end ?? 19;
  return {
    id: 55,
    source_entry_id: 7,
    anchor_start: start,
    anchor_end: end,
    anchor_text: Array.from(BODY).slice(start, end).join('').trim(),
    pending: true,
    stale: false,
    ...overrides,
  };
}

function renderScreen(params?: { entryId?: number }) {
  const route = { key: 'k', name: 'JournalEntry' as const, params };
  const navigation = { navigate: jest.fn(), goBack: jest.fn(), push: jest.fn() };
  const Screen = JournalEntryScreen as unknown as React.ComponentType<Record<string, unknown>>;
  return { ...render(<Screen navigation={navigation} route={route} />), navigation };
}

beforeEach(() => {
  mockGet.mockReset();
  mockCreate.mockReset();
  mockUpdate.mockReset();
  mockCreate.mockResolvedValue(entry({ id: 42 }));
  mockUpdate.mockResolvedValue(entry({ id: 42 }));
  mockList.mockReset();
  mockList.mockResolvedValue({ items: [] });
  mockCompletionList.mockReset();
  mockCompletionList.mockResolvedValue({ items: [] });
  mockPromote.mockReset();
  mockRemovePromotion.mockReset();
  mockPromotionsList.mockReset();
  mockPromotionsList.mockResolvedValue([]);
  mockGet.mockResolvedValue(entry());
});

describe('JournalEntryScreen -- promote-a-quote render parity', () => {
  it('with zero promotions, the existing read-mode tree is unchanged', async () => {
    const { findByTestId, queryAllByTestId } = renderScreen({ entryId: 7 });
    expect(await findByTestId('journal-body-read')).toBeTruthy();
    expect(queryAllByTestId(/^quote-highlight-/)).toHaveLength(0);
  });
});

describe('JournalEntryScreen -- promote-a-quote affordance', () => {
  it('shows a touch-target-sized "Promote a quote" affordance in read mode', async () => {
    const { findByTestId } = renderScreen({ entryId: 7 });
    const button = await findByTestId('promote-quote-button');
    expect(button.props.accessibilityLabel).toBe('Promote a quote');
    const style = StyleSheet.flatten(button.props.style);
    expect(style.minHeight).toBeGreaterThanOrEqual(touchTarget.minimum);
  });

  it('entering selection mode renders a controlled TextInput seeded with the body', async () => {
    const { findByTestId, getByTestId } = renderScreen({ entryId: 7 });
    fireEvent.press(await findByTestId('promote-quote-button'));
    const input = getByTestId('quote-select-input');
    expect(input.props.value).toBe(BODY);
  });

  it('cancelling selection leaves selection mode without promoting', async () => {
    const { findByTestId, getByTestId, queryByTestId } = renderScreen({ entryId: 7 });
    fireEvent.press(await findByTestId('promote-quote-button'));
    expect(getByTestId('quote-select-input')).toBeTruthy();
    fireEvent.press(getByTestId('quote-select-cancel'));
    expect(queryByTestId('quote-select-input')).toBeNull();
    expect(getByTestId('promote-quote-button')).toBeTruthy(); // back in read mode
    expect(mockPromote).not.toHaveBeenCalled();
  });

  it('entering selection mode renders the instruction line', async () => {
    const { findByTestId } = renderScreen({ entryId: 7 });
    fireEvent.press(await findByTestId('promote-quote-button'));
    expect(await findByTestId('quote-select-instruction')).toBeTruthy();
  });

  it('a nonempty selection renders the live preview', async () => {
    const { findByTestId, getByTestId } = renderScreen({ entryId: 7 });
    fireEvent.press(await findByTestId('promote-quote-button'));
    const input = getByTestId('quote-select-input');
    fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 2, end: 19 } } });
    expect(await findByTestId('quote-select-preview')).toBeTruthy();
  });

  it('pressing the confirm guard on a collapsed selection shows a hint and promotes nothing', async () => {
    const { findByTestId, getByTestId } = renderScreen({ entryId: 7 });
    fireEvent.press(await findByTestId('promote-quote-button'));
    const input = getByTestId('quote-select-input');
    // A caret tap with no highlighted span reports start === end.
    fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 5, end: 5 } } });
    fireEvent.press(getByTestId('quote-select-confirm-guard'));
    expect(await findByTestId('quote-select-hint')).toBeTruthy();
    expect(mockPromote).not.toHaveBeenCalled();
    expect(getByTestId('quote-select-input')).toBeTruthy(); // still selecting
  });

  it('confirming a selection calls promotions.create with the exact offsets', async () => {
    mockPromote.mockResolvedValue(promotedQuote());
    const { findByTestId, getByTestId } = renderScreen({ entryId: 7 });
    fireEvent.press(await findByTestId('promote-quote-button'));
    const input = getByTestId('quote-select-input');
    fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 2, end: 19 } } });

    await act(async () => {
      fireEvent.press(getByTestId('quote-select-confirm'));
    });
    expect(mockPromote).toHaveBeenCalledWith(7, { anchor_start: 2, anchor_end: 19 });
  });

  it('promotes against the created id after finishing a new entry without reopening', async () => {
    mockPromote.mockResolvedValue(promotedQuote({ id: 90, source_entry_id: 42 }));
    const { getByTestId, findByTestId } = renderScreen();
    fireEvent.changeText(getByTestId('journal-body-input'), BODY);

    await act(async () => {
      fireEvent.press(getByTestId('journal-finish-button'));
    });
    fireEvent.press(await findByTestId('promote-quote-button'));
    const input = getByTestId('quote-select-input');
    fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 2, end: 19 } } });
    await act(async () => {
      fireEvent.press(getByTestId('quote-select-confirm'));
    });

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ message: BODY }));
    expect(mockPromote).toHaveBeenCalledWith(42, { anchor_start: 2, anchor_end: 19 });
  });

  it('on a 201 the promoted span appears back in the read-mode body', async () => {
    mockPromote.mockResolvedValue(promotedQuote({ id: 90 }));
    const { findByTestId, getByTestId } = renderScreen({ entryId: 7 });
    fireEvent.press(await findByTestId('promote-quote-button'));
    const input = getByTestId('quote-select-input');
    fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 2, end: 19 } } });
    await act(async () => {
      fireEvent.press(getByTestId('quote-select-confirm'));
    });
    expect(await findByTestId('quote-highlight-90')).toBeTruthy();
  });

  it('a 422 error surfaces a hint, keeps the body rendered, and never navigates away', async () => {
    mockPromote.mockRejectedValue({ status: 422, detail: 'anchor_out_of_range' });
    const { findByTestId, getByTestId, navigation } = renderScreen({ entryId: 7 });
    fireEvent.press(await findByTestId('promote-quote-button'));
    const input = getByTestId('quote-select-input');
    fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 0, end: 9999 } } });
    await act(async () => {
      fireEvent.press(getByTestId('quote-select-confirm'));
    });

    expect(await findByTestId('quote-promotion-error')).toBeTruthy();
    expect(getByTestId('journal-body-read')).toBeTruthy();
    expect(navigation.navigate).not.toHaveBeenCalled();
    expect(mockGet).toHaveBeenCalledTimes(1); // reading position wasn't lost to a reload
  });
});

// RED: anchors are code points, but the TextInput reports UTF-16 offsets, so a leading emoji drifts them.
describe('JournalEntryScreen -- promote-a-quote code-point anchors (non-BMP)', () => {
  const EMOJI = '\u{1F600}';
  const EMOJI_BODY = `${EMOJI}went for a daily walk.`;

  it('converts a UTF-16 selection over an emoji-led body to code-point anchor offsets', async () => {
    mockGet.mockResolvedValue(entry({ message: EMOJI_BODY }));
    mockPromote.mockResolvedValue(
      promotedQuote({ anchor_start: 1, anchor_end: 17, anchor_text: 'went for a daily' }),
    );
    const { findByTestId, getByTestId } = renderScreen({ entryId: 7 });
    fireEvent.press(await findByTestId('promote-quote-button'));
    const input = getByTestId('quote-select-input');
    // The one leading astral char shifts every later UTF-16 offset by +1 vs its code-point index.
    fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 2, end: 18 } } });

    await act(async () => {
      fireEvent.press(getByTestId('quote-select-confirm'));
    });
    expect(mockPromote).toHaveBeenCalledWith(7, { anchor_start: 1, anchor_end: 17 });
  });
});

describe('JournalEntryScreen -- removing a promoted quote', () => {
  async function promoteOne(screen: ReturnType<typeof renderScreen>): Promise<void> {
    mockPromote.mockResolvedValue(promotedQuote({ id: 90 }));
    fireEvent.press(await screen.findByTestId('promote-quote-button'));
    const input = screen.getByTestId('quote-select-input');
    fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 2, end: 19 } } });
    await act(async () => {
      fireEvent.press(screen.getByTestId('quote-select-confirm'));
    });
    await screen.findByTestId('quote-highlight-90');
  }

  it('tapping a quote span offers "Remove promotion", which calls promotions.remove', async () => {
    const screen = renderScreen({ entryId: 7 });
    await promoteOne(screen);

    fireEvent.press(screen.getByTestId('quote-highlight-90'));
    const removeButton = await screen.findByTestId('promotion-remove-90');
    expect(removeButton.props.accessibilityLabel).toBe('Remove promotion');

    await act(async () => {
      fireEvent.press(removeButton);
    });
    expect(mockRemovePromotion).toHaveBeenCalledWith(90);
    await waitFor(() => expect(screen.queryByTestId('quote-highlight-90')).toBeNull());
  });

  it('a failed removal reverts the span back into view', async () => {
    mockRemovePromotion.mockRejectedValue({ status: 500, detail: 'boom' });
    const screen = renderScreen({ entryId: 7 });
    await promoteOne(screen);

    fireEvent.press(screen.getByTestId('quote-highlight-90'));
    const removeButton = await screen.findByTestId('promotion-remove-90');
    await act(async () => {
      fireEvent.press(removeButton);
    });
    expect(await screen.findByTestId('quote-highlight-90')).toBeTruthy();
  });
});

describe('JournalEntryScreen -- reopening a finished entry hydrates promoted-quote highlights', () => {
  it('renders every promoted quote returned by promotions.list', async () => {
    mockGet.mockResolvedValue(entry({ status: 'finished' }));
    mockPromotionsList.mockResolvedValue([
      promotedQuote({ id: 12, anchor_start: 2, anchor_end: 6 }),
      promotedQuote({ id: 34, anchor_start: 21, anchor_end: 24 }),
    ]);
    const { findByTestId } = renderScreen({ entryId: 7 });

    expect(await findByTestId('journal-body-read')).toBeTruthy();
    expect(await findByTestId('quote-highlight-12')).toBeTruthy();
    expect(await findByTestId('quote-highlight-34')).toBeTruthy();
    expect(mockPromotionsList).toHaveBeenCalledWith(7);
  });
});

describe('JournalEntryScreen -- promote lifecycle feedback (in-flight, success, retry)', () => {
  async function confirmSelection(screen: ReturnType<typeof renderScreen>): Promise<void> {
    fireEvent.press(await screen.findByTestId('promote-quote-button'));
    const input = screen.getByTestId('quote-select-input');
    fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 2, end: 19 } } });
  }

  async function promoteOne(screen: ReturnType<typeof renderScreen>): Promise<void> {
    mockPromote.mockResolvedValue(promotedQuote({ id: 90 }));
    await confirmSelection(screen);
    await act(async () => {
      fireEvent.press(screen.getByTestId('quote-select-confirm'));
    });
    await screen.findByTestId('quote-highlight-90');
  }

  it('shows an in-flight notice while the promote POST is pending and clears it on resolution', async () => {
    const { promise, resolve } = deferredPromote();
    mockPromote.mockReturnValue(promise);
    const screen = renderScreen({ entryId: 7 });
    await confirmSelection(screen);

    fireEvent.press(screen.getByTestId('quote-select-confirm'));
    expect(await screen.findByTestId('quote-promotion-inflight')).toBeTruthy();
    expect(screen.getByTestId('journal-body-read')).toBeTruthy();
    expect(mockGet).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve(promotedQuote({ id: 90 }));
      await promise;
    });
    await waitFor(() => expect(screen.queryByTestId('quote-promotion-inflight')).toBeNull());
  });

  it('shows a transient success notice that auto-dismisses after PROMOTED_NOTICE_MS', async () => {
    mockPromote.mockResolvedValue(promotedQuote({ id: 90 }));
    const screen = renderScreen({ entryId: 7 });
    await confirmSelection(screen);

    jest.useFakeTimers();
    try {
      await act(async () => {
        fireEvent.press(screen.getByTestId('quote-select-confirm'));
      });
      expect(screen.getByTestId('quote-promotion-success')).toBeTruthy();

      act(() => {
        jest.advanceTimersByTime(PROMOTED_NOTICE_MS);
      });
      expect(screen.queryByTestId('quote-promotion-success')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('a failed promote shows the error notice and retry re-posts the same anchors', async () => {
    mockPromote.mockRejectedValueOnce({ status: 500, detail: 'boom' });
    mockPromote.mockResolvedValueOnce(promotedQuote({ id: 90 }));
    const screen = renderScreen({ entryId: 7 });
    await confirmSelection(screen);
    await act(async () => {
      fireEvent.press(screen.getByTestId('quote-select-confirm'));
    });

    expect(await screen.findByTestId('quote-promotion-error')).toBeTruthy();
    const retryButton = screen.getByTestId('quote-promotion-retry');

    await act(async () => {
      fireEvent.press(retryButton);
    });
    expect(mockPromote).toHaveBeenNthCalledWith(2, 7, { anchor_start: 2, anchor_end: 19 });
    expect(await screen.findByTestId('quote-highlight-90')).toBeTruthy();
    expect(screen.queryByTestId('quote-select-input')).toBeNull();
  });

  it('the anchored remove affordance shows the tapped quote text', async () => {
    const screen = renderScreen({ entryId: 7 });
    await promoteOne(screen);

    fireEvent.press(screen.getByTestId('quote-highlight-90'));
    expect(await screen.findByTestId('promotion-remove-90')).toBeTruthy();
    const quoteText = screen.getByTestId('promotion-remove-quote-90');
    expect(quoteText.props.children).toEqual(
      expect.stringContaining(promotedQuote({ id: 90 }).anchor_text),
    );
  });

  it('pressing elsewhere in the body dismisses the revealed remove affordance', async () => {
    const screen = renderScreen({ entryId: 7 });
    await promoteOne(screen);

    fireEvent.press(screen.getByTestId('quote-highlight-90'));
    expect(await screen.findByTestId('promotion-remove-90')).toBeTruthy();

    fireEvent(screen.getByTestId('journal-body-read'), 'click');
    expect(screen.queryByTestId('promotion-remove-90')).toBeNull();
  });

  it('a failed remove restores the quote highlight and shows a legible error notice', async () => {
    mockRemovePromotion.mockRejectedValue({ status: 500, detail: 'boom' });
    const screen = renderScreen({ entryId: 7 });
    await promoteOne(screen);

    fireEvent.press(screen.getByTestId('quote-highlight-90'));
    const removeButton = await screen.findByTestId('promotion-remove-90');
    await act(async () => {
      fireEvent.press(removeButton);
    });
    expect(await screen.findByTestId('quote-highlight-90')).toBeTruthy();
    expect(await screen.findByTestId('quote-promotion-error')).toBeTruthy();
  });

  it('a failed remove after a failed promote drops the mis-contexted promote retry', async () => {
    mockPromotionsList.mockResolvedValue([promotedQuote({ id: 90 })]);
    mockPromote.mockRejectedValue({ status: 500, detail: 'boom' });
    mockRemovePromotion.mockRejectedValue({ status: 500, detail: 'boom' });
    const screen = renderScreen({ entryId: 7 });
    await screen.findByTestId('quote-highlight-90');

    await confirmSelection(screen);
    await act(async () => {
      fireEvent.press(screen.getByTestId('quote-select-confirm'));
    });
    expect(await screen.findByTestId('quote-promotion-retry')).toBeTruthy();

    fireEvent.press(screen.getByTestId('quote-highlight-90'));
    const removeButton = await screen.findByTestId('promotion-remove-90');
    await act(async () => {
      fireEvent.press(removeButton);
    });
    expect(await screen.findByTestId('quote-promotion-error')).toBeTruthy();
    expect(screen.queryByTestId('quote-promotion-retry')).toBeNull();
  });
});

describe('JournalEntryScreen -- promotions follow the server after an edited save (#2891)', () => {
  it('refetches promotions (and marginalia) after an edited finished entry is saved', async () => {
    jest.useFakeTimers();
    try {
      mockPromotionsList.mockResolvedValueOnce([promotedQuote()]);
      const route = { key: 'k', name: 'JournalEntry' as const, params: { entryId: 7 } };
      const navigation = { navigate: jest.fn(), goBack: jest.fn(), push: jest.fn() };
      const Screen = JournalEntryScreen as unknown as React.ComponentType<Record<string, unknown>>;
      const { getByTestId, findByTestId } = render(
        <Screen navigation={navigation} route={route} autosaveDelayMs={100} />,
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockPromotionsList).toHaveBeenCalledTimes(1);
      fireEvent.press(getByTestId('journal-edit-button'));
      fireEvent.press(getByTestId('edit-confirm-edit'));
      const input = await findByTestId('journal-body-input');
      mockList.mockClear();
      mockPromotionsList.mockResolvedValueOnce([
        promotedQuote({ anchor_start: 8, anchor_end: 25 }),
      ]);
      fireEvent.changeText(input, `Before: ${BODY}`);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      expect(mockUpdate).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ message: `Before: ${BODY}` }),
      );
      expect(mockPromotionsList).toHaveBeenCalledTimes(2);
      expect(mockPromotionsList).toHaveBeenLastCalledWith(7);
      expect(mockList).toHaveBeenCalledWith(7);
    } finally {
      jest.useRealTimers();
    }
  });
});

/**
 * The server's ``sanitize_user_text``, as far as a body is concerned: NFC, the
 * zero-width / directional marks U+200B-U+200F stripped, edges trimmed.
 */
function serverStored(typed: string): string {
  return typed
    .normalize('NFC')
    .replace(/[\u200B-\u200F]/gu, '')
    .trim();
}

describe('JournalEntryScreen -- read mode adopts the server-stored body after Finish (#2891)', () => {
  const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
  const CASES: { name: string; typed: string; quoted: string }[] = [
    { name: 'a decomposed combining mark', typed: 'Cafe\u0301 by the river.', quoted: 'river' },
    { name: 'a ZWJ emoji sequence', typed: `${FAMILY} walked to the river.`, quoted: 'river' },
    { name: 'a leading nested bullet', typed: '  - by the river\n  - and back', quoted: 'river' },
    { name: 'a leading newline', typed: '\n> a quote\n\nby the river', quoted: 'river' },
  ];

  it.each(CASES)('promotes offsets into the stored body after $name', async ({ typed, quoted }) => {
    jest.useFakeTimers();
    try {
      const stored = serverStored(typed);
      expect(stored).not.toBe(typed); // the case really exercises sanitize
      mockUpdate.mockImplementation((id: number) =>
        Promise.resolve(entry({ id, message: stored, status: 'finished' })),
      );
      mockPromote.mockResolvedValue(promotedQuote({ id: 91, source_entry_id: 42 }));
      const route = { key: 'k', name: 'JournalEntry' as const, params: undefined };
      const navigation = { navigate: jest.fn(), goBack: jest.fn(), push: jest.fn() };
      const Screen = JournalEntryScreen as unknown as React.ComponentType<Record<string, unknown>>;
      const { getByTestId, findByTestId } = render(
        <Screen navigation={navigation} route={route} autosaveDelayMs={100} />,
      );
      fireEvent.changeText(getByTestId('journal-body-input'), typed);
      await act(async () => {
        fireEvent.press(getByTestId('journal-finish-button'));
      });
      fireEvent.press(await findByTestId('promote-quote-button'));
      const input = getByTestId('quote-select-input');
      expect(input.props.value).toBe(stored);

      const startUtf16 = stored.indexOf(quoted);
      fireEvent(input, 'selectionChange', {
        nativeEvent: { selection: { start: startUtf16, end: startUtf16 + quoted.length } },
      });
      await act(async () => {
        fireEvent.press(getByTestId('quote-select-confirm'));
      });
      const [, span] = mockPromote.mock.calls[0]!;
      expect(Array.from(stored).slice(span.anchor_start, span.anchor_end).join('')).toBe(quoted);

      // Adopting the stored body is not an edit: no further write follows it.
      const writes = mockUpdate.mock.calls.length + mockCreate.mock.calls.length;
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1000);
      });
      // Closing flushes only what is not yet durable; the stored body already is.
      await act(async () => {
        fireEvent.press(getByTestId('journal-close-entry'));
        await jest.advanceTimersByTimeAsync(0);
      });
      expect(navigation.navigate).toHaveBeenCalled();
      expect(mockUpdate.mock.calls.length + mockCreate.mock.calls.length).toBe(writes);
    } finally {
      jest.useRealTimers();
    }
  });

  it('adopts the stored body when Finish updates an entry an autosave already created', async () => {
    jest.useFakeTimers();
    try {
      const typed = 'Cafe\u0301 by the river.  ';
      mockCreate.mockResolvedValue(entry({ id: 42, message: typed, status: 'draft' }));
      mockUpdate.mockImplementation((id: number, patch: unknown) =>
        Promise.resolve(
          entry({
            id,
            message: serverStored((patch as { message: string }).message),
            status: 'finished',
          }),
        ),
      );
      const route = { key: 'k', name: 'JournalEntry' as const, params: undefined };
      const navigation = { navigate: jest.fn(), goBack: jest.fn(), push: jest.fn() };
      const Screen = JournalEntryScreen as unknown as React.ComponentType<Record<string, unknown>>;
      const { getByTestId, findByTestId } = render(
        <Screen navigation={navigation} route={route} autosaveDelayMs={100} />,
      );
      fireEvent.changeText(getByTestId('journal-body-input'), typed);
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      expect(mockCreate).toHaveBeenCalledTimes(1);
      await act(async () => {
        fireEvent.press(getByTestId('journal-finish-button'));
      });
      // The UPDATE branch of the Finish write: the id already existed.
      expect(mockUpdate).toHaveBeenCalledWith(42, expect.objectContaining({ status: 'finished' }));
      fireEvent.press(await findByTestId('promote-quote-button'));
      expect(getByTestId('quote-select-input').props.value).toBe(serverStored(typed));
    } finally {
      jest.useRealTimers();
    }
  });

  it('shows the stored body, not the typed one, when text is typed during the Finish write', async () => {
    // The server keeps one copy of the body: whatever it stored last, sanitized.
    let stored = '';
    let releaseFinish: () => void = () => {};
    mockCreate.mockImplementation((payload) => {
      stored = serverStored((payload as { message: string }).message);
      return Promise.resolve(entry({ id: 42, message: stored, status: 'draft' }));
    });
    mockUpdate.mockImplementation((id: number, patch: unknown) => {
      const { message, status } = patch as { message?: string; status?: string };
      if (message != null) stored = serverStored(message);
      const reply = entry({ id, message: stored, status: 'finished' });
      if (status !== 'finished') return Promise.resolve(reply);
      return new Promise<JournalMessage>((resolve) => {
        releaseFinish = () => resolve(reply);
      });
    });
    mockGet.mockImplementation((id: number) => Promise.resolve(entry({ id, message: stored })));
    const route = { key: 'k', name: 'JournalEntry' as const, params: undefined };
    const navigation = { navigate: jest.fn(), goBack: jest.fn(), push: jest.fn() };
    const Screen = JournalEntryScreen as unknown as React.ComponentType<Record<string, unknown>>;
    const { getByTestId, findByTestId } = render(
      <Screen navigation={navigation} route={route} autosaveDelayMs={100} />,
    );
    fireEvent.changeText(getByTestId('journal-body-input'), '\nby the river');
    await act(async () => {
      fireEvent.press(getByTestId('journal-finish-button'));
    });
    fireEvent.changeText(getByTestId('journal-body-input'), '\nby the river and back');
    await act(async () => {
      releaseFinish();
    });
    fireEvent.press(await findByTestId('promote-quote-button'));
    const surface = getByTestId('quote-select-input');
    expect(stored).toBe('by the river and back');
    expect(surface.props.value).toBe(stored);

    mockPromote.mockResolvedValue(promotedQuote({ id: 93, source_entry_id: 42 }));
    const at = stored.indexOf('river');
    fireEvent(surface, 'selectionChange', {
      nativeEvent: { selection: { start: at, end: at + 'river'.length } },
    });
    await act(async () => {
      fireEvent.press(getByTestId('quote-select-confirm'));
    });
    const [, span] = mockPromote.mock.calls[0]!;
    expect(Array.from(stored).slice(span.anchor_start, span.anchor_end).join('')).toBe('river');
  });

  it('keeps the writer in the editor when text typed during Finish cannot be saved', async () => {
    let releaseFinish: () => void = () => {};
    mockUpdate.mockImplementation((id: number, patch: unknown) => {
      if ((patch as { status?: string }).status !== 'finished') {
        return Promise.reject(new Error('offline'));
      }
      return new Promise<JournalMessage>((resolve) => {
        releaseFinish = () => resolve(entry({ id, message: 'by the river', status: 'finished' }));
      });
    });
    const route = { key: 'k', name: 'JournalEntry' as const, params: undefined };
    const navigation = { navigate: jest.fn(), goBack: jest.fn(), push: jest.fn() };
    const Screen = JournalEntryScreen as unknown as React.ComponentType<Record<string, unknown>>;
    const { getByTestId, findByTestId, queryByTestId } = render(
      <Screen navigation={navigation} route={route} autosaveDelayMs={100} />,
    );
    fireEvent.changeText(getByTestId('journal-body-input'), 'by the river');
    await act(async () => {
      fireEvent.press(getByTestId('journal-finish-button'));
    });
    fireEvent.changeText(getByTestId('journal-body-input'), 'by the river and back');
    await act(async () => {
      releaseFinish();
    });
    expect(await findByTestId('journal-finish-error')).toBeTruthy();
    expect(getByTestId('journal-body-input').props.value).toBe('by the river and back');
    expect(queryByTestId('journal-body-read')).toBeNull();
    expect(mockGet).not.toHaveBeenCalled();
  });
});

describe('JournalEntryScreen -- promote posts source offsets, never display offsets (#2891)', () => {
  const MARKED = '**bo\u{1F600}ld** _x_ tail';

  it('sends utf16ToSource of the selection, which differs from the visible offset', async () => {
    mockGet.mockResolvedValue(entry({ message: MARKED }));
    mockPromote.mockResolvedValue(promotedQuote({ id: 92 }));
    const { findByTestId, getByTestId } = renderScreen({ entryId: 7 });
    fireEvent.press(await findByTestId('promote-quote-button'));
    const selection = { start: MARKED.indexOf('tail'), end: MARKED.length };
    const source = {
      start: utf16ToSource(MARKED, selection.start),
      end: utf16ToSource(MARKED, selection.end),
    };
    const document = parseJournalMarkdown(MARKED);
    const visible = {
      start: sourceToVisible(document, source.start),
      end: sourceToVisible(document, source.end),
    };
    // The guard is only meaningful where the coordinate systems really differ.
    expect(visible.start).not.toBe(source.start);
    expect(source.start).not.toBe(selection.start);

    fireEvent(getByTestId('quote-select-input'), 'selectionChange', {
      nativeEvent: { selection },
    });
    await act(async () => {
      fireEvent.press(getByTestId('quote-select-confirm'));
    });
    expect(mockPromote).toHaveBeenCalledWith(7, {
      anchor_start: source.start,
      anchor_end: source.end,
    });
  });
});
