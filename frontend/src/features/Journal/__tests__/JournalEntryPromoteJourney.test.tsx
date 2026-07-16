/* eslint-env jest */
// Journey-level regression capstone: both promote-a-quote surfaces (read-mode
// select-a-span and in-panel reflection re-promotion) already shipped, so this
// spec is GREEN by construction. Bite-proofing lives in the mutation protocol
// run alongside this file, not in a natural RED here.
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import type { JournalMessage, PromotedQuote, ReflectionDue, ReflectionSourceItem } from '@/api';

/** A never-settling promise plus its resolve, for pinning a slow ``promotions.list`` hydrate. */
function deferredPromotionsList(): {
  promise: Promise<PromotedQuote[]>;
  resolve: (_value: PromotedQuote[]) => void;
} {
  let resolve: (_value: PromotedQuote[]) => void = () => {};
  const promise = new Promise<PromotedQuote[]>((res) => {
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
const mockRespond = jest.fn() as jest.MockedFunction<(_w: number, _b: string) => Promise<unknown>>;
const mockPromote = jest.fn() as jest.MockedFunction<
  (_entryId: number, _span: { anchor_start: number; anchor_end: number }) => Promise<PromotedQuote>
>;
const mockRemovePromotion = jest.fn() as jest.MockedFunction<(_id: number) => Promise<void>>;
const mockPromotionsList = jest.fn() as jest.MockedFunction<
  (_entryId: number) => Promise<PromotedQuote[]>
>;
const mockSetIncluded = jest.fn() as jest.MockedFunction<
  (_id: number, _entryId: number | null) => Promise<unknown>
>;
const mockReflectionsDue = jest.fn() as jest.MockedFunction<
  () => Promise<{ due: ReflectionDue | null }>
>;
const mockReflectionsSources = jest.fn() as jest.MockedFunction<
  (_level: string, _scopeKey: string) => Promise<{ items: ReflectionSourceItem[] }>
>;

jest.mock('@/api', () => ({
  journal: {
    get: (...a: unknown[]) => (mockGet as unknown as (...x: unknown[]) => unknown)(...a),
    create: (...a: unknown[]) => (mockCreate as unknown as (...x: unknown[]) => unknown)(...a),
    update: (...a: unknown[]) => (mockUpdate as unknown as (...x: unknown[]) => unknown)(...a),
  },
  prompts: {
    respond: (...a: unknown[]) => (mockRespond as unknown as (...x: unknown[]) => unknown)(...a),
  },
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
    setIncluded: (...a: unknown[]) =>
      (mockSetIncluded as unknown as (...x: unknown[]) => unknown)(...a),
    list: (...a: unknown[]) =>
      (mockPromotionsList as unknown as (...x: unknown[]) => unknown)(...a),
  },
  reflections: {
    due: (...a: unknown[]) => (mockReflectionsDue as unknown as (...x: unknown[]) => unknown)(...a),
    sources: (...a: unknown[]) =>
      (mockReflectionsSources as unknown as (...x: unknown[]) => unknown)(...a),
  },
}));

jest.mock('@/navigation/hooks', () => ({
  ...(jest.requireActual('@/navigation/hooks') as Record<string, unknown>),
  useAppNavigation: () => ({ navigate: jest.fn(), setOptions: jest.fn() }),
}));

const JournalEntryScreen = require('../JournalEntryScreen').default;

const BODY = 'A page about a daily run to the river and back.';
const EMOJI = '\u{1F600}';
const EMOJI_BODY = `${EMOJI}went for a daily walk.`;

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
    status: 'finished',
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

function item(overrides: Partial<ReflectionSourceItem> = {}): ReflectionSourceItem {
  return {
    kind: 'entry',
    id: 1,
    title: 'Entry title',
    timestamp: '2026-06-01T00:00:00Z',
    body: 'The full body of the entry, longer than any excerpt.',
    reflection_level: null,
    promoted_quotes: [],
    ...overrides,
  };
}

const sourceItem = item({ id: 1, body: EMOJI_BODY });

const REFLECTION_PARAMS = {
  reflectionLevel: 'stage',
  reflectionScopeKey: 'c1:s1',
  prefillTitle: 'Stage Reflection — Survival',
};

function renderScreen(params?: Record<string, unknown>) {
  const route = { key: 'k', name: 'JournalEntry' as const, params };
  const navigation = {
    navigate: jest.fn(),
    replace: jest.fn(),
    goBack: jest.fn(),
    push: jest.fn(),
  };
  const Screen = JournalEntryScreen as unknown as React.ComponentType<Record<string, unknown>>;
  return {
    ...render(<Screen navigation={navigation} route={route} />),
    navigation,
  };
}

type Screen = ReturnType<typeof renderScreen>;

/** Opens read-mode selection, returning the seeded input for further assertion. */
async function openSelectionSurface(screen: Screen) {
  fireEvent.press(await screen.findByTestId('promote-quote-button'));
  return screen.getByTestId('quote-select-input');
}

/** Selects ``selection`` on the read-mode surface and confirms it. */
async function selectAndConfirmReadMode(
  screen: Screen,
  selection: { start: number; end: number },
): Promise<void> {
  const input = await openSelectionSurface(screen);
  fireEvent(input, 'selectionChange', { nativeEvent: { selection } });
  await act(async () => {
    fireEvent.press(screen.getByTestId('quote-select-confirm'));
  });
}

/** Opens the reflection sources panel via the toggle button. */
async function openReflectionSources(screen: Screen): Promise<void> {
  await act(async () => {
    fireEvent.press(await screen.findByTestId('reflection-sources-toggle'));
  });
}

/** Expands the entry row and opens its promote opener. */
async function openSourcePromoter(screen: Screen, id: number): Promise<void> {
  fireEvent.press(await screen.findByTestId(`entry-source-${id}`));
  fireEvent.press(screen.getByTestId(`source-promote-entry-${id}`));
}

/** Selects ``selection`` on the given source's selection surface and confirms it. */
async function selectAndConfirmSource(
  screen: Screen,
  id: number,
  selection: { start: number; end: number },
): Promise<void> {
  const input = screen.getByTestId(`source-select-entry-${id}-input`);
  fireEvent(input, 'selectionChange', { nativeEvent: { selection } });
  await act(async () => {
    fireEvent.press(screen.getByTestId(`source-select-entry-${id}-confirm`));
  });
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
  mockRespond.mockReset();
  mockRespond.mockResolvedValue({});
  mockPromote.mockReset();
  mockRemovePromotion.mockReset();
  mockPromotionsList.mockReset();
  mockPromotionsList.mockResolvedValue([]);
  mockSetIncluded.mockReset();
  mockSetIncluded.mockResolvedValue(promotedQuote());
  mockReflectionsDue.mockReset();
  mockReflectionsDue.mockResolvedValue({ due: null });
  mockReflectionsSources.mockReset();
  mockReflectionsSources.mockResolvedValue({ items: [] });
  mockGet.mockResolvedValue(entry());
});

describe('JournalEntryPromoteJourney -- read-mode journey (finished entry, entryId 7)', () => {
  it('promotes a quote, reopens the entry, then removes the promotion (rejected then accepted)', async () => {
    mockPromote.mockResolvedValue(promotedQuote({ id: 90 }));
    const screen = renderScreen({ entryId: 7 });

    const input = await openSelectionSurface(screen);
    expect(input.props.value).toBe(BODY);
    fireEvent(input, 'selectionChange', { nativeEvent: { selection: { start: 2, end: 19 } } });
    await act(async () => {
      fireEvent.press(screen.getByTestId('quote-select-confirm'));
    });
    expect(mockPromote).toHaveBeenCalledWith(7, { anchor_start: 2, anchor_end: 19 });
    expect(await screen.findByTestId('quote-highlight-90')).toBeTruthy();

    screen.unmount();
    mockPromotionsList.mockResolvedValue([promotedQuote({ id: 90 })]);
    const reopened = renderScreen({ entryId: 7 });
    expect(await reopened.findByTestId('quote-highlight-90')).toBeTruthy();
    expect(mockPromotionsList).toHaveBeenCalledWith(7);

    mockRemovePromotion.mockRejectedValueOnce({ status: 500, detail: 'boom' });
    fireEvent.press(reopened.getByTestId('quote-highlight-90'));
    const removeButton = await reopened.findByTestId('promotion-remove-90');
    const quoteText = reopened.getByTestId('promotion-remove-quote-90');
    expect(quoteText.props.children).toEqual(
      expect.stringContaining(promotedQuote({ id: 90 }).anchor_text),
    );
    await act(async () => {
      fireEvent.press(removeButton);
    });
    expect(await reopened.findByTestId('quote-highlight-90')).toBeTruthy();
    expect(await reopened.findByTestId('quote-promotion-error')).toBeTruthy();

    mockRemovePromotion.mockResolvedValueOnce(undefined);
    fireEvent.press(reopened.getByTestId('quote-highlight-90'));
    const removeAgain = await reopened.findByTestId('promotion-remove-90');
    await act(async () => {
      fireEvent.press(removeAgain);
    });
    await waitFor(() => expect(reopened.queryByTestId('quote-highlight-90')).toBeNull());
  });

  it('stages a failed promote with retry, then succeeds on retry with the same anchors', async () => {
    mockPromote.mockRejectedValueOnce({ status: 500, detail: 'boom' });
    mockPromote.mockResolvedValueOnce(promotedQuote({ id: 90 }));
    const screen = renderScreen({ entryId: 7 });
    await selectAndConfirmReadMode(screen, { start: 2, end: 19 });

    expect(await screen.findByTestId('quote-promotion-error')).toBeTruthy();
    expect(screen.getByTestId('quote-promotion-retry')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByTestId('quote-promotion-retry'));
    });
    expect(mockPromote).toHaveBeenNthCalledWith(2, 7, { anchor_start: 2, anchor_end: 19 });
    expect(await screen.findByTestId('quote-highlight-90')).toBeTruthy();
  });

  it('converts a UTF-16 selection over a non-BMP body to code-point anchors', async () => {
    mockGet.mockResolvedValue(entry({ message: EMOJI_BODY }));
    mockPromote.mockResolvedValue(promotedQuote({ anchor_start: 1, anchor_end: 17, id: 90 }));
    const screen = renderScreen({ entryId: 7 });
    await selectAndConfirmReadMode(screen, { start: 2, end: 18 });

    expect(mockPromote).toHaveBeenCalledWith(7, { anchor_start: 1, anchor_end: 17 });
    expect(await screen.findByTestId('quote-highlight-90')).toBeTruthy();
  });

  it('keeps an in-flight promote and a slower hydration merge without clobbering either', async () => {
    const list = deferredPromotionsList();
    mockPromotionsList.mockReturnValue(list.promise);
    mockPromote.mockResolvedValue(promotedQuote({ id: 90 }));
    const screen = renderScreen({ entryId: 7 });
    await selectAndConfirmReadMode(screen, { start: 2, end: 19 });
    expect(await screen.findByTestId('quote-highlight-90')).toBeTruthy();

    await act(async () => {
      list.resolve([promotedQuote({ id: 12, anchor_start: 21, anchor_end: 25 })]);
      await list.promise;
    });
    expect(await screen.findByTestId('quote-highlight-12')).toBeTruthy();
    expect(screen.getByTestId('quote-highlight-90')).toBeTruthy();
  });
});

describe('JournalEntryPromoteJourney -- reflection-panel re-promotion (draft entry)', () => {
  it('promotes a selected span through the real sources panel with code-point anchors', async () => {
    mockReflectionsSources.mockResolvedValue({ items: [sourceItem] });
    mockPromote.mockResolvedValue(
      promotedQuote({
        id: 501,
        source_entry_id: 1,
        anchor_start: 1,
        anchor_end: 17,
        anchor_text: 'went for a daily walk',
      }),
    );
    const screen = renderScreen(REFLECTION_PARAMS);
    await openReflectionSources(screen);
    await openSourcePromoter(screen, 1);
    await selectAndConfirmSource(screen, 1, { start: 2, end: 18 });

    expect(mockPromote).toHaveBeenCalledWith(1, { anchor_start: 1, anchor_end: 17 });
  });

  it('shows the row hint by testID when the in-panel re-promotion fails', async () => {
    mockReflectionsSources.mockResolvedValue({ items: [sourceItem] });
    mockPromote.mockRejectedValue({ status: 500, detail: 'boom' });
    const screen = renderScreen(REFLECTION_PARAMS);
    await openReflectionSources(screen);
    await openSourcePromoter(screen, 1);
    await selectAndConfirmSource(screen, 1, { start: 2, end: 18 });

    expect(await screen.findByTestId('source-promote-hint')).toBeTruthy();
    expect(screen.getByTestId('source-promote-entry-1')).toBeTruthy();
  });
});
