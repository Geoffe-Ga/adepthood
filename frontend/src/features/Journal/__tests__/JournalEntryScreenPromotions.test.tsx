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
import type { JournalMessage, PromotedQuote } from '@/api';
import { touchTarget } from '@/design/tokens';

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

function promotedQuote(overrides: Partial<PromotedQuote> = {}): PromotedQuote {
  return {
    id: 55,
    source_entry_id: 7,
    anchor_start: 2,
    anchor_end: 19,
    anchor_text: 'went for a daily',
    pending: true,
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
