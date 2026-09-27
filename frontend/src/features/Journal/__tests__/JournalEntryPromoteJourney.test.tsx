/* eslint-env jest */
// Journey-level regression capstone: both promote-a-quote surfaces (read-mode
// select-a-span and in-panel reflection re-promotion) already shipped, so this
// spec is GREEN by construction. Bite-proofing lives in the mutation protocol
// run alongside this file, not in a natural RED here.
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
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

// ``useAuth`` throws outside a provider; the screen reads only the zone.
jest.mock('@/context/AuthContext', () => require('./authContextTestKit'));

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

jest.mock('@/context/ApiKeyContext', () => require('./apiKeyContextTestKit'));
jest.mock('@/storage/promoteExplainerStorage', () => require('./promoteExplainerTestKit'));

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
    mockPromote.mockResolvedValue(
      promotedQuote({ anchor_start: 1, anchor_end: 17, anchor_text: 'went for a daily', id: 90 }),
    );
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

// #2883: the panel closes by its X, Escape/back, or (on the sheet) a backdrop
// tap -- and closing it closes ONLY it. The route stays, the draft and any
// folded-in quote stay in the body, and focus goes back to the Sources toggle.
describe('JournalEntryPromoteJourney -- sources panel navigation (#2883)', () => {
  const FOLD_QUOTE = {
    id: 77,
    anchor_start: 0,
    anchor_end: 6,
    anchor_text: 'A page',
    pending: true,
  };
  const foldSource = item({ id: 1, body: BODY, promoted_quotes: [FOLD_QUOTE] });
  const DRAFT = 'What the week left behind.';
  let toggleFocus: jest.Mock;

  /**
   * Spy on the focus() of the component instance the toggle's ref resolves to:
   * the nearest ancestor of its host node that carries native methods.
   */
  function spyOnFocus(host: ReturnType<Screen['getByTestId']>): jest.Mock {
    let node: typeof host | null = host;
    while (
      node != null &&
      typeof (node.instance as { focus?: unknown } | null)?.focus !== 'function'
    ) {
      node = node.parent;
    }
    if (node == null) throw new Error('no focusable instance above the toggle');
    return jest.spyOn(node.instance as { focus: () => void }, 'focus') as unknown as jest.Mock;
  }

  function atWidth(width: number): void {
    const rn = require('react-native');
    jest
      .spyOn(rn, 'useWindowDimensions')
      .mockReturnValue({ width, height: 800, scale: 1, fontScale: 1 });
  }

  /** Opens Sources on a drafted reflection and folds the pending quote in. */
  async function openWithDraftAndFold(): Promise<Screen> {
    mockReflectionsSources.mockResolvedValue({ items: [foldSource] });
    const screen = renderScreen(REFLECTION_PARAMS);
    fireEvent.changeText(screen.getByTestId('journal-body-input'), DRAFT);
    await openReflectionSources(screen);
    await act(async () => {
      fireEvent.press(await screen.findByTestId('pending-quote-77'));
    });
    toggleFocus = spyOnFocus(screen.getByTestId('reflection-sources-toggle'));
    return screen;
  }

  function expectOnlyThePanelClosed(screen: Screen, bodyBefore: string, frame: string): void {
    expect(screen.queryByTestId(frame)).toBeNull();
    expect(screen.getByTestId('journal-body-input').props.value).toBe(bodyBefore);
    expect(bodyBefore).toContain(DRAFT);
    expect(bodyBefore).toContain('A page');
    expect(screen.navigation.goBack).not.toHaveBeenCalled();
    expect(screen.navigation.navigate).not.toHaveBeenCalled();
    expect(screen.navigation.replace).not.toHaveBeenCalled();
    expect(screen.getByTestId('journal-screen')).toBeTruthy();
    expect(toggleFocus).toHaveBeenCalledTimes(1);
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sets the wide pane BESIDE the writing sheet, in one row', async () => {
    atWidth(1280);
    const screen = await openWithDraftAndFold();
    const row = screen.getByTestId('journal-compose-row');
    expect(within(row).getByTestId('journal-sheet')).toBeTruthy();
    expect(within(row).getByTestId('reflection-sources-pane')).toBeTruthy();
    const { StyleSheet } = require('react-native');
    expect(StyleSheet.flatten(row.props.style).flexDirection).toBe('row');
  });

  it('closes only the wide pane with its X, returning focus to the Sources toggle', async () => {
    atWidth(1280);
    const screen = await openWithDraftAndFold();
    const bodyBefore = screen.getByTestId('journal-body-input').props.value as string;
    expect(toggleFocus).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('reflection-sources-close'));
    expectOnlyThePanelClosed(screen, bodyBefore, 'reflection-sources-pane');
  });

  it('closes only the wide pane on the hardware back button, which never pops the route', async () => {
    const rn = require('react-native');
    let back: (() => boolean | null | undefined) | undefined;
    jest.spyOn(rn.BackHandler, 'addEventListener').mockImplementation((...args: unknown[]) => {
      back = args[1] as () => boolean;
      return { remove: jest.fn() };
    });
    atWidth(1280);
    const screen = await openWithDraftAndFold();
    const bodyBefore = screen.getByTestId('journal-body-input').props.value as string;
    let consumed: boolean | null | undefined;
    act(() => {
      consumed = back?.();
    });
    expect(consumed).toBe(true);
    expectOnlyThePanelClosed(screen, bodyBefore, 'reflection-sources-pane');
  });

  it('closes only the narrow sheet on Escape or back (the Modal request)', async () => {
    atWidth(390);
    const screen = await openWithDraftAndFold();
    const bodyBefore = screen.getByTestId('journal-body-input').props.value as string;
    act(() => {
      screen.getByTestId('reflection-sources-sheet').props.onRequestClose();
    });
    expectOnlyThePanelClosed(screen, bodyBefore, 'reflection-sources-sheet');
  });

  it('closes only the narrow sheet on a backdrop tap', async () => {
    atWidth(390);
    const screen = await openWithDraftAndFold();
    const bodyBefore = screen.getByTestId('journal-body-input').props.value as string;
    fireEvent.press(screen.getByTestId('reflection-sources-backdrop'));
    expectOnlyThePanelClosed(screen, bodyBefore, 'reflection-sources-sheet');
  });

  it('reopens with the draft intact after closing', async () => {
    atWidth(1280);
    const screen = await openWithDraftAndFold();
    const bodyBefore = screen.getByTestId('journal-body-input').props.value as string;
    fireEvent.press(screen.getByTestId('reflection-sources-close'));
    await openReflectionSources(screen);
    expect(screen.getByTestId('reflection-sources-pane')).toBeTruthy();
    expect(screen.getByTestId('journal-body-input').props.value).toBe(bodyBefore);
  });
});
