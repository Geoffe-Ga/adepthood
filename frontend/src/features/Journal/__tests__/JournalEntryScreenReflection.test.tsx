/* eslint-env jest */
// RED: `JournalEntryScreen` does not yet recognize the `reflectionLevel` /
// `reflectionScopeKey` route params, does not call `reflections.sources`, and
// never sends `reflection_level`/`reflection_scope_key` on `journal.create` --
// every case below fails until the implementation-specialist wires reflection
// mode through the screen.
//
// `../ReflectionSourcesPanel` is stubbed to a button that fires
// `onInsertQuote(quote, sourceItem)` -- this file pins the create/setIncluded/
// 409 wiring, not the panel's own rendering (covered by
// `ReflectionSourcesPanel.test.tsx`).
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import { BookOpen } from 'lucide-react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import { ENTRY_WIDTHS, exitRowOrder, spyWidth } from './entryLayoutTestKit';
import { KEYED } from './idempotencyTestKit';

import type {
  JournalMessage,
  PromotedQuote,
  PromotedQuoteSummary,
  ReflectionCurrentScope,
  ReflectionDue,
  ReflectionSourceItem,
  ReflectionSourcesResponse,
} from '@/api';
import { decorativeHidden } from '@/components/a11yHidden';
import { NAV_ICON_SIZE, NAV_ICON_STROKE } from '@/components/drawer';
import { accent, touchTarget } from '@/design/tokens';

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
const mockSetIncluded = jest.fn() as jest.MockedFunction<
  (_id: number, _entryId: number | null) => Promise<unknown>
>;
const mockReflectionsCurrent = jest.fn() as jest.MockedFunction<
  () => Promise<{ scopes: ReflectionCurrentScope[] }>
>;
const mockReflectionsDue = jest.fn() as jest.MockedFunction<
  () => Promise<{ due: ReflectionDue | null }>
>;
const mockReflectionsSources = jest.fn() as jest.MockedFunction<
  (_level: string, _scopeKey: string) => Promise<ReflectionSourcesResponse>
>;
const mockPromotionsCreate = jest.fn() as jest.MockedFunction<
  (_entryId: number, _span: { anchor_start: number; anchor_end: number }) => Promise<PromotedQuote>
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
    create: (...a: unknown[]) =>
      (mockPromotionsCreate as unknown as (...x: unknown[]) => unknown)(...a),
    remove: jest.fn(),
    setIncluded: (...a: unknown[]) =>
      (mockSetIncluded as unknown as (...x: unknown[]) => unknown)(...a),
    list: jest.fn(() => Promise.resolve([])),
  },
  reflections: {
    due: (...a: unknown[]) => (mockReflectionsDue as unknown as (...x: unknown[]) => unknown)(...a),
    current: (...a: unknown[]) =>
      (mockReflectionsCurrent as unknown as (...x: unknown[]) => unknown)(...a),
    sources: (...a: unknown[]) =>
      (mockReflectionsSources as unknown as (...x: unknown[]) => unknown)(...a),
  },
}));

// Names are `mock`-prefixed so babel-plugin-jest-hoist allows referencing
// them from inside the `jest.mock(...)` factory below.
const mockStubQuote: PromotedQuoteSummary = {
  id: 90,
  anchor_start: 2,
  anchor_end: 19,
  anchor_text: 'went for a daily walk',
  pending: true,
};

const mockStubSourceItem: ReflectionSourceItem = {
  kind: 'entry',
  id: 1,
  title: 'Runs',
  timestamp: '2026-06-01T00:00:00Z',
  body: 'I went for a daily walk to the river.',
  reflection_level: null,
  promoted_quotes: [mockStubQuote],
};

// Fixed span the stub asks to promote from `mockStubSourceItem`.
const mockStubPromoteSpan = { anchor_start: 2, anchor_end: 19 };

// A second pending quote on the same source, so a test can start one fold-in
// and then another before the first has settled.
const mockSecondQuote: PromotedQuoteSummary = {
  id: 91,
  anchor_start: 23,
  anchor_end: 36,
  anchor_text: 'to the river',
  pending: true,
};

const mockTwoQuoteSource: ReflectionSourceItem = {
  ...mockStubSourceItem,
  promoted_quotes: [mockStubQuote, mockSecondQuote],
};

jest.mock('../ReflectionSourcesPanel', () => {
  const { Text, TouchableOpacity } = require('react-native');
  const Stub = ({
    items,
    onInsertQuote,
    onInsertQuotes,
    foldedIds,
    onPromoteSpan,
    window: reviewWindow,
    anchorStatus,
    feedStatus,
  }: {
    items: ReflectionSourceItem[];
    window?: { start: string; end: string };
    anchorStatus?: string;
    feedStatus?: string;
    onInsertQuote: (
      _q: PromotedQuoteSummary,
      _item: ReflectionSourceItem,
    ) => Promise<boolean> | undefined;
    onInsertQuotes?: (
      _c: ReadonlyArray<{ id: number; anchorText: string; attribution: string }>,
    ) => Promise<unknown>;
    foldedIds?: ReadonlySet<number>;
    onPromoteSpan?: (
      _item: ReflectionSourceItem,
      _span: { anchor_start: number; anchor_end: number },
    ) => Promise<boolean>;
  }) => {
    const pendingIds = items
      .flatMap((source) => source.promoted_quotes)
      .filter((quote) => quote.pending)
      .map((quote) => quote.id);
    return (
      <>
        <TouchableOpacity
          testID="stub-insert-quote"
          onPress={() => onInsertQuote(mockStubQuote, mockStubSourceItem)}
        >
          <Text>Insert stub quote</Text>
        </TouchableOpacity>
        {items.flatMap((source) =>
          source.promoted_quotes
            .filter((quote) => quote.pending)
            .map((quote) => (
              <TouchableOpacity
                key={quote.id}
                testID={`stub-insert-quote-${quote.id}`}
                onPress={() => onInsertQuote(quote, source)}
              >
                <Text>{`Insert ${quote.id}`}</Text>
              </TouchableOpacity>
            )),
        )}
        {onPromoteSpan == null ? null : (
          <TouchableOpacity
            testID="stub-promote-span"
            onPress={() => {
              void onPromoteSpan(mockStubSourceItem, mockStubPromoteSpan);
            }}
          >
            <Text>Promote stub span</Text>
          </TouchableOpacity>
        )}
        <Text testID="stub-pending-ids">{pendingIds.join(',')}</Text>
        <Text testID="stub-source-ids">{items.map((source) => source.id).join(',')}</Text>
        <Text testID="stub-window">
          {reviewWindow == null ? '' : `${reviewWindow.start}..${reviewWindow.end}`}
        </Text>
        <Text testID="stub-anchor-status">{anchorStatus ?? ''}</Text>
        <Text testID="stub-feed-status">{feedStatus ?? ''}</Text>
        <Text testID="stub-folded-ids">{[...(foldedIds ?? [])].join(',')}</Text>
        {onInsertQuotes == null ? null : (
          <TouchableOpacity
            testID="stub-insert-batch"
            onPress={() => {
              void onInsertQuotes([
                { id: 90, anchorText: 'went for a daily walk', attribution: 'Runs' },
                { id: 91, anchorText: 'to the river', attribution: 'Runs' },
              ]);
            }}
          >
            <Text>Insert a batch</Text>
          </TouchableOpacity>
        )}
      </>
    );
  };
  return { __esModule: true, default: Stub };
});

jest.mock('@/navigation/hooks', () => ({
  ...(jest.requireActual('@/navigation/hooks') as Record<string, unknown>),
  useAppNavigation: () => ({ navigate: jest.fn(), setOptions: jest.fn() }),
}));

jest.mock('@/context/ApiKeyContext', () => require('./apiKeyContextTestKit'));

const JournalEntryScreen = require('../JournalEntryScreen').default;

function entry(overrides: Partial<JournalMessage> = {}): JournalMessage {
  return {
    id: 42,
    message: 'A reflection on the week.',
    sender: 'user',
    timestamp: '2026-07-01T00:00:00Z',
    tag: 'reflection' as JournalMessage['tag'],
    practice_session_id: null,
    user_practice_id: null,
    title: 'Stage Reflection — Survival',
    status: 'draft',
    updated_at: '2026-07-01T00:00:00Z',
    ...overrides,
  };
}

function renderScreen(params?: Record<string, unknown>, extraProps: Record<string, unknown> = {}) {
  const route = { key: 'k', name: 'JournalEntry' as const, params };
  const navigation = {
    navigate: jest.fn(),
    replace: jest.fn(),
    goBack: jest.fn(),
    push: jest.fn(),
  };
  const Screen = JournalEntryScreen as unknown as React.ComponentType<Record<string, unknown>>;
  return {
    ...render(<Screen navigation={navigation} route={route} {...extraProps} />),
    navigation,
  };
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
  mockSetIncluded.mockReset();
  mockSetIncluded.mockResolvedValue(mockStubQuote);
  mockReflectionsDue.mockReset();
  mockReflectionsDue.mockResolvedValue({ due: null });
  mockReflectionsCurrent.mockReset();
  mockReflectionsCurrent.mockResolvedValue({ scopes: [] });
  mockReflectionsSources.mockReset();
  mockReflectionsSources.mockResolvedValue({ items: [] });
  mockPromotionsCreate.mockReset();
});

/** The narrowest phone the exit row must still fit on one line. */
const NARROWEST_PHONE_WIDTH = 375;

/** A wide desktop window, past the margin's side-by-side breakpoint. */
const WIDE_DESKTOP_WIDTH = 1280;

/** A course hand-off, so the exit row also carries "Back to reading". */
const RETURN_TO = {
  screen: 'Course',
  params: { stageNumber: 3, contentId: 11, scrollOffset: 120 },
};

const REFLECTION_PARAMS = {
  reflectionLevel: 'stage',
  reflectionScopeKey: 'c1:s1',
  prefillTitle: 'Stage Reflection — Survival',
};

describe('JournalEntryScreen -- reflection mode', () => {
  /** A reflection draft opened at ``width``, with its first effects settled. */
  async function renderReflectionAt(width: number, params: Record<string, unknown> = {}) {
    const restore = spyWidth(width);
    const screen = renderScreen({ ...REFLECTION_PARAMS, ...params });
    await act(async () => {
      await Promise.resolve();
    });
    return { screen, restore };
  }

  // #3002: Sources is a page-level door while writing a reflection, so it sits
  // in the exit row beside the key and the camera, icon-only like them.
  it.each([...ENTRY_WIDTHS, { width: NARROWEST_PHONE_WIDTH }, { width: WIDE_DESKTOP_WIDTH }])(
    'puts the icon-only Sources toggle in the exit row beside the key and camera at $width px',
    async ({ width }) => {
      const { screen, restore } = await renderReflectionAt(width);
      try {
        const exitRow = screen.getByTestId('journal-entry-exit-row');
        expect(exitRowOrder(exitRow)).toEqual([
          'journal-api-key-settings',
          'reflection-sources-toggle',
          'journal-photograph-page',
          'journal-close-entry',
        ]);
        const rail = within(screen.getByTestId('journal-writing-controls'));
        expect(rail.queryByTestId('reflection-sources-toggle')).toBeNull();
        expect(rail.queryByTestId('journal-photograph-page')).toBeNull();

        const sources = within(exitRow).getByTestId('reflection-sources-toggle');
        expect(within(sources).getByTestId('reflection-sources-icon')).toBeTruthy();
        // Glyph over word at every width: the phrase is the accessible name alone.
        expect(within(sources).queryByText('Sources')).toBeNull();
        expect(screen.queryByText('Sources')).toBeNull();
        expect(sources.props.accessibilityRole).toBe('button');
        expect(sources.props.accessibilityLabel).toBe(
          'Open the sources to reread earlier writing and gather quotes',
        );
        // The same footprint as the X it sits beside.
        const sourcesStyle = StyleSheet.flatten(sources.props.style);
        expect(sourcesStyle).toEqual(
          StyleSheet.flatten(screen.getByTestId('journal-close-entry').props.style),
        );
        expect(sourcesStyle.minWidth).toBeGreaterThanOrEqual(touchTarget.minimum);
        expect(sourcesStyle.minHeight).toBeGreaterThanOrEqual(touchTarget.minimum);
        // The book glyph is decoration; the toggle's own label names it (#2829).
        const glyphs = screen.UNSAFE_getAllByType(BookOpen);
        expect(glyphs).toHaveLength(1);
        expect(glyphs[0]?.props).toMatchObject({
          size: NAV_ICON_SIZE,
          strokeWidth: NAV_ICON_STROKE,
          color: accent.primary,
          ...decorativeHidden(),
        });
        screen.unmount();
      } finally {
        restore();
      }
    },
  );

  it.each(ENTRY_WIDTHS)(
    'keeps the course return first, ahead of the key, Sources, camera and X at $width px',
    async ({ width }) => {
      const { screen, restore } = await renderReflectionAt(width, { returnTo: RETURN_TO });
      try {
        expect(exitRowOrder(screen.getByTestId('journal-entry-exit-row'))).toEqual([
          'journal-return-to-reading',
          'journal-api-key-settings',
          'reflection-sources-toggle',
          'journal-photograph-page',
          'journal-close-entry',
        ]);
        screen.unmount();
      } finally {
        restore();
      }
    },
  );

  // #3002: a finished review opens in read mode with its reflection still
  // active; the sources dock acts on a page being written, so the door is shut.
  it('hides Sources in read mode while the reflection stays active', async () => {
    mockGet.mockResolvedValue(
      entry({ status: 'finished', reflection_level: 'stage', reflection_scope_key: 'c1:s1' }),
    );
    const screen = renderScreen({ entryId: 42 });
    expect(await screen.findByTestId('journal-edit-button')).toBeTruthy();
    // Prove the reflection really is active here: its sources feed was fetched.
    expect(mockReflectionsSources.mock.calls[0]?.slice(0, 2)).toEqual(['stage', 'c1:s1']);

    expect(screen.queryByTestId('reflection-sources-toggle')).toBeNull();
    expect(exitRowOrder(screen.getByTestId('journal-entry-exit-row'))).not.toContain(
      'reflection-sources-toggle',
    );
  });

  it('pre-fills the title, sends reflection fields on create, offers Finish, and never calls prompts.respond', async () => {
    jest.useFakeTimers();
    try {
      const { getByTestId } = renderScreen(REFLECTION_PARAMS, { autosaveDelayMs: 100 });
      expect(getByTestId('journal-title-input').props.value).toBe('Stage Reflection — Survival');

      fireEvent.changeText(getByTestId('journal-body-input'), 'A reflection on the week.');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'A reflection on the week.',
          tag: 'hierarchical_reflection',
          reflection_level: 'stage',
          reflection_scope_key: 'c1:s1',
        }),
        KEYED,
      );
      expect(mockRespond).not.toHaveBeenCalled();
      expect(getByTestId('journal-finish-button')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('fetches the sources feed for the reflection level/scope on mount', async () => {
    renderScreen(REFLECTION_PARAMS);
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockReflectionsSources.mock.calls[0]?.slice(0, 2)).toEqual(['stage', 'c1:s1']);
  });

  it('restores reflection mode from a saved entry opened from the journal shelf', async () => {
    mockGet.mockResolvedValue(entry({ reflection_level: 'stage', reflection_scope_key: 'c1:s1' }));

    const screen = renderScreen({ entryId: 42 });

    expect(await screen.findByTestId('reflection-sources-toggle')).toBeTruthy();
    expect(mockReflectionsSources.mock.calls[0]?.slice(0, 2)).toEqual(['stage', 'c1:s1']);
  });

  it('inserts a blockquote on a tapped pending quote and folds it in via setIncluded once the entry saves', async () => {
    jest.useFakeTimers();
    try {
      const { getByTestId, findByTestId } = renderScreen(REFLECTION_PARAMS, {
        autosaveDelayMs: 100,
      });
      await act(async () => {
        fireEvent.press(await findByTestId('reflection-sources-toggle'));
      });
      const insertButton = await findByTestId('stub-insert-quote');

      await act(async () => {
        fireEvent.press(insertButton);
      });

      const body = getByTestId('journal-body-input').props.value as string;
      expect(body).toContain('went for a daily walk');
      expect(body).toContain('>');

      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });

      expect(mockSetIncluded).toHaveBeenCalledWith(90, 42);
    } finally {
      jest.useRealTimers();
    }
  });

  // A fold-in is ONE writer-facing act made of two writes: the entry body, then
  // the mark that retires the quote from the pending set. The hint used to settle
  // to "Saved" the moment the first landed, so the page announced a finished save
  // while the second was still on the wire -- and a reader (or a test) that acted
  // on that word saw the quote still pending.
  it('holds the hint at Saving until the folded quote has been marked included', async () => {
    let releaseSetIncluded: () => void = () => undefined;
    mockSetIncluded.mockReturnValue(
      new Promise<unknown>((resolve) => {
        releaseSetIncluded = () => resolve(mockStubQuote);
      }),
    );
    jest.useFakeTimers();
    try {
      const { getByTestId, findByTestId } = renderScreen(REFLECTION_PARAMS, {
        autosaveDelayMs: 100,
      });
      await act(async () => {
        fireEvent.press(await findByTestId('reflection-sources-toggle'));
      });
      const insertButton = await findByTestId('stub-insert-quote');

      await act(async () => {
        fireEvent.press(insertButton);
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });

      // The entry itself is written and the mark is in flight: not saved yet.
      expect(mockSetIncluded).toHaveBeenCalledWith(90, 42);
      expect(getByTestId('journal-save-hint').props.children).toBe('Saving…');

      await act(async () => {
        releaseSetIncluded();
        await jest.advanceTimersByTimeAsync(0);
      });

      expect(getByTestId('journal-save-hint').props.children).toBe('Saved');
    } finally {
      jest.useRealTimers();
    }
  });

  // Nothing in the panel stops a second tap while the first fold-in is still in
  // flight: the "already folded in" guard is per ROW, so quote B is tappable
  // while quote A's mark is on the wire. A flag that only records THAT an act is
  // running (rather than how many are) is lowered by whichever finishes first,
  // and the page says "Saved" with B still pending -- the very defect this fix
  // exists to remove, moved behind a second tap.
  it('keeps the hint at Saving until every overlapping fold-in has settled', async () => {
    mockReflectionsSources.mockResolvedValue({ items: [mockTwoQuoteSource] });
    const release = new Map<number, () => void>();
    mockSetIncluded.mockImplementation(
      (id: number) =>
        new Promise<unknown>((resolve) => {
          release.set(id, () => resolve(mockStubQuote));
        }),
    );
    jest.useFakeTimers();
    try {
      const { getByTestId, findByTestId } = renderScreen(REFLECTION_PARAMS, {
        autosaveDelayMs: 100,
      });
      await act(async () => {
        fireEvent.press(await findByTestId('reflection-sources-toggle'));
      });

      // Start A, let its draft save land, then start B on top of it.
      await act(async () => {
        fireEvent.press(await findByTestId('stub-insert-quote-90'));
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      await act(async () => {
        fireEvent.press(await findByTestId('stub-insert-quote-91'));
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });

      expect(mockSetIncluded).toHaveBeenCalledWith(90, 42);
      expect(mockSetIncluded).toHaveBeenCalledWith(91, 42);
      expect(getByTestId('journal-save-hint').props.children).toBe('Saving…');

      // A settles alone. B's quote is still pending, so nothing is saved yet.
      await act(async () => {
        release.get(90)?.();
        await jest.advanceTimersByTimeAsync(0);
      });
      expect(getByTestId('journal-save-hint').props.children).toBe('Saving…');

      await act(async () => {
        release.get(91)?.();
        await jest.advanceTimersByTimeAsync(0);
      });
      expect(getByTestId('journal-save-hint').props.children).toBe('Saved');
    } finally {
      jest.useRealTimers();
    }
  });

  // The complement: a mark that never lands must not strand the hint on
  // "Saving…" forever -- it settles, and the warm hint says what did not happen.
  it('settles the hint and warns when the inclusion mark fails', async () => {
    mockSetIncluded.mockRejectedValue({ status: 500, detail: 'boom' });
    jest.useFakeTimers();
    try {
      const { getByTestId, findByTestId } = renderScreen(REFLECTION_PARAMS, {
        autosaveDelayMs: 100,
      });
      await act(async () => {
        fireEvent.press(await findByTestId('reflection-sources-toggle'));
      });
      await act(async () => {
        fireEvent.press(await findByTestId('stub-insert-quote'));
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });

      expect(getByTestId('journal-save-hint').props.children).toBe('Saved');
      expect(getByTestId('quote-inclusion-hint')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('leaves the quote pending and surfaces a warm hint when setIncluded rejects, without crashing', async () => {
    mockSetIncluded.mockRejectedValue({ status: 500, detail: 'boom' });
    jest.useFakeTimers();
    try {
      const { findByTestId } = renderScreen(REFLECTION_PARAMS, { autosaveDelayMs: 100 });
      await act(async () => {
        fireEvent.press(await findByTestId('reflection-sources-toggle'));
      });
      const insertButton = await findByTestId('stub-insert-quote');

      await act(async () => {
        fireEvent.press(insertButton);
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });

      expect(await findByTestId('quote-inclusion-hint')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('on a 409 create conflict, consults reflections.due and routes to the existing entry', async () => {
    mockCreate.mockRejectedValue({ status: 409, detail: 'reflection_already_exists' });
    mockReflectionsDue.mockResolvedValue({
      due: {
        level: 'stage',
        scope_key: 'c1:s1',
        window_start: '2026-06-01T00:00:00Z',
        window_end: '2026-07-01T00:00:00Z',
        existing_entry_id: 77,
      },
    });
    jest.useFakeTimers();
    try {
      const { getByTestId, navigation } = renderScreen(REFLECTION_PARAMS, {
        autosaveDelayMs: 100,
      });
      fireEvent.changeText(getByTestId('journal-body-input'), 'A reflection on the week.');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });

      expect(mockReflectionsDue).toHaveBeenCalled();
      const replaceCall = navigation.replace.mock.calls[0];
      const navigateCall = navigation.navigate.mock.calls.find(
        (call: unknown[]) =>
          call[0] === 'JournalEntry' &&
          (call[1] as Record<string, unknown> | undefined)?.entryId === 77,
      );
      const routedToExisting =
        (replaceCall != null &&
          replaceCall[0] === 'JournalEntry' &&
          (replaceCall[1] as Record<string, unknown> | undefined)?.entryId === 77) ||
        navigateCall != null;
      expect(routedToExisting).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('JournalEntryScreen -- a review begun early that collides with one already written', () => {
  it('on a 409 for a scope that is not due, finds the live review among the open scopes and opens it', async () => {
    mockCreate.mockRejectedValue({ status: 409, detail: 'reflection_scope_taken' });
    // Nothing is due today: the scope was begun early from the picker.
    mockReflectionsDue.mockResolvedValue({ due: null });
    mockReflectionsCurrent.mockResolvedValue({
      scopes: [
        {
          level: 'week',
          scope_key: 'c1:w2',
          window_start: '2026-07-08T00:00:00Z',
          window_end: '2026-07-15T00:00:00Z',
          existing_entry_id: 88,
        },
      ],
    });
    jest.useFakeTimers();
    try {
      const { getByTestId, navigation } = renderScreen(
        {
          reflectionLevel: 'week',
          reflectionScopeKey: 'c1:w2',
          prefillTitle: 'Weekly Review — Week 2',
        },
        { autosaveDelayMs: 100 },
      );
      fireEvent.changeText(getByTestId('journal-body-input'), 'Halfway through week two.');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });

      expect(navigation.replace).toHaveBeenCalledWith('JournalEntry', { entryId: 88 });
    } finally {
      jest.useRealTimers();
    }
  });

  it('leaves the retryable save error alone when no open scope claims the key', async () => {
    mockCreate.mockRejectedValue({ status: 409, detail: 'reflection_scope_taken' });
    // Another scope's live review must never be mistaken for this one's.
    mockReflectionsCurrent.mockResolvedValue({
      scopes: [
        {
          level: 'stage',
          scope_key: 'c1:s1',
          window_start: '2026-07-01T00:00:00Z',
          window_end: '2026-07-22T00:00:00Z',
          existing_entry_id: 5,
        },
      ],
    });
    jest.useFakeTimers();
    try {
      const { getByTestId, navigation } = renderScreen(
        { reflectionLevel: 'week', reflectionScopeKey: 'c1:w2', prefillTitle: 'Weekly Review' },
        { autosaveDelayMs: 100 },
      );
      fireEvent.changeText(getByTestId('journal-body-input'), 'Halfway through week two.');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });

      expect(navigation.replace).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});

// RED: the screen does not yet pass `onPromoteSpan` to the sources panel.
describe('JournalEntryScreen -- in-panel re-promotion (reflection mode)', () => {
  it('promotes a selected span from a source and folds the created quote into the pending set', async () => {
    mockReflectionsSources.mockResolvedValue({ items: [mockStubSourceItem] });
    mockPromotionsCreate.mockResolvedValue({
      id: 501,
      source_entry_id: mockStubSourceItem.id,
      anchor_start: mockStubPromoteSpan.anchor_start,
      anchor_end: mockStubPromoteSpan.anchor_end,
      anchor_text: 'went for a daily walk',
      pending: true,
      stale: false,
    });
    const { findByTestId } = renderScreen(REFLECTION_PARAMS);
    await act(async () => {
      fireEvent.press(await findByTestId('reflection-sources-toggle'));
    });
    await act(async () => {
      fireEvent.press(await findByTestId('stub-promote-span'));
    });

    expect(mockPromotionsCreate).toHaveBeenCalledWith(mockStubSourceItem.id, mockStubPromoteSpan);
    expect((await findByTestId('stub-pending-ids')).props.children).toContain('501');
  });

  it('leaves the pending set unchanged when promotions.create rejects, without crashing', async () => {
    mockReflectionsSources.mockResolvedValue({ items: [mockStubSourceItem] });
    mockPromotionsCreate.mockRejectedValue({ status: 500, detail: 'boom' });
    const { findByTestId } = renderScreen(REFLECTION_PARAMS);
    await act(async () => {
      fireEvent.press(await findByTestId('reflection-sources-toggle'));
    });
    await act(async () => {
      fireEvent.press(await findByTestId('stub-promote-span'));
    });

    expect((await findByTestId('stub-pending-ids')).props.children).not.toContain('501');
  });

  it('single-flights a hanging promote so a double press calls create once', async () => {
    mockReflectionsSources.mockResolvedValue({ items: [mockStubSourceItem] });
    let resolveCreate: (_value: PromotedQuote) => void = () => undefined;
    mockPromotionsCreate.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const { findByTestId } = renderScreen(REFLECTION_PARAMS);
    await act(async () => {
      fireEvent.press(await findByTestId('reflection-sources-toggle'));
    });
    const button = await findByTestId('stub-promote-span');
    await act(async () => {
      fireEvent.press(button);
      fireEvent.press(button);
    });
    resolveCreate({
      id: 501,
      source_entry_id: mockStubSourceItem.id,
      anchor_start: mockStubPromoteSpan.anchor_start,
      anchor_end: mockStubPromoteSpan.anchor_end,
      anchor_text: 'went for a daily walk',
      pending: true,
      stale: false,
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockPromotionsCreate).toHaveBeenCalledTimes(1);
  });

  it('shows the fold-in hint on a failed setIncluded, then clears it on the next successful one', async () => {
    mockSetIncluded.mockRejectedValueOnce({ status: 500, detail: 'boom' });
    mockSetIncluded.mockResolvedValueOnce(mockStubQuote);
    jest.useFakeTimers();
    try {
      const { findByTestId, queryByTestId } = renderScreen(REFLECTION_PARAMS, {
        autosaveDelayMs: 100,
      });
      await act(async () => {
        fireEvent.press(await findByTestId('reflection-sources-toggle'));
      });
      const insertButton = await findByTestId('stub-insert-quote');

      await act(async () => {
        fireEvent.press(insertButton);
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      expect(await findByTestId('quote-inclusion-hint')).toBeTruthy();

      await act(async () => {
        fireEvent.press(insertButton);
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      expect(queryByTestId('quote-inclusion-hint')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('JournalEntryScreen -- weekly-prompt mode regression', () => {
  it('still calls prompts.respond and carries no reflection scope fields', async () => {
    jest.useFakeTimers();
    try {
      const { getByTestId } = renderScreen(
        {
          weekNumber: 3,
          promptQuestion: 'What did you notice?',
          prefillTitle: 'Week 3 Reflection',
        },
        { autosaveDelayMs: 100 },
      );
      fireEvent.changeText(getByTestId('journal-body-input'), 'I noticed the willow.');
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      expect(mockRespond).toHaveBeenCalledWith(3, 'I noticed the willow.', {
        title: 'Week 3 Reflection',
        ...KEYED,
      });
      expect(mockCreate).not.toHaveBeenCalled();
      const respondArgs = mockRespond.mock.calls[0];
      expect(respondArgs).toHaveLength(3);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('JournalEntryScreen -- the scope the panel is showing', () => {
  function rerenderWithParams(
    screen: ReturnType<typeof renderScreen>,
    params: Record<string, unknown>,
  ): void {
    const Screen = JournalEntryScreen as unknown as React.ComponentType<Record<string, unknown>>;
    screen.rerender(
      <Screen
        navigation={screen.navigation}
        route={{ key: 'k', name: 'JournalEntry' as const, params }}
      />,
    );
  }

  it("refetches the sources feed when the route's reflection scope changes", async () => {
    const screen = renderScreen(REFLECTION_PARAMS);
    await act(async () => {
      await Promise.resolve();
    });

    rerenderWithParams(screen, { reflectionLevel: 'week', reflectionScopeKey: 'c1:w1' });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockReflectionsSources.mock.calls.map((call) => call[1])).toEqual(['c1:s1', 'c1:w1']);
  });

  it("clears the previous review's sources when the next scope's fetch fails", async () => {
    mockReflectionsSources.mockResolvedValueOnce({ items: [mockStubSourceItem] });
    const screen = renderScreen(REFLECTION_PARAMS);
    await act(async () => {
      fireEvent.press(await screen.findByTestId('reflection-sources-toggle'));
    });
    expect(screen.getByTestId('stub-source-ids').props.children).toBe('1');

    mockReflectionsSources.mockRejectedValueOnce(new Error('scope_locked'));
    rerenderWithParams(screen, { reflectionLevel: 'week', reflectionScopeKey: 'c1:w1' });
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId('stub-source-ids').props.children).toBe('');
  });

  it('lets a late response for the previous scope never populate the new one', async () => {
    let settleFirst: (_value: { items: ReflectionSourceItem[] }) => void = () => {};
    mockReflectionsSources.mockReturnValueOnce(
      new Promise((resolve) => {
        settleFirst = resolve;
      }),
    );
    mockReflectionsSources.mockResolvedValueOnce({ items: [] });
    const screen = renderScreen(REFLECTION_PARAMS);
    await act(async () => {
      fireEvent.press(await screen.findByTestId('reflection-sources-toggle'));
    });

    rerenderWithParams(screen, { reflectionLevel: 'week', reflectionScopeKey: 'c1:w1' });
    await act(async () => {
      settleFirst({ items: [mockStubSourceItem] });
      await Promise.resolve();
    });

    expect(screen.getByTestId('stub-source-ids').props.children).toBe('');
  });

  it('keeps the reflection period the server declared for the scope on screen', async () => {
    mockReflectionsSources.mockResolvedValueOnce({
      items: [],
      level: 'stage',
      scope_key: 'c1:s1',
      window_start: '2026-06-01T04:00:00Z',
      window_end: '2026-06-22T04:00:00Z',
    });
    const screen = renderScreen(REFLECTION_PARAMS);
    await act(async () => {
      fireEvent.press(await screen.findByTestId('reflection-sources-toggle'));
    });

    expect(screen.getByTestId('stub-window').props.children).toBe(
      '2026-06-01T04:00:00Z..2026-06-22T04:00:00Z',
    );
  });

  it("hands the panel the server's anchor_status, so an unreconstructable period can say so", async () => {
    mockReflectionsSources.mockResolvedValueOnce({
      items: [],
      level: 'stage',
      scope_key: 'c1:s1',
      window_start: null,
      window_end: null,
      anchor_status: 'unrecorded',
    });
    const screen = renderScreen(REFLECTION_PARAMS);
    await act(async () => {
      fireEvent.press(await screen.findByTestId('reflection-sources-toggle'));
    });

    expect(screen.getByTestId('stub-anchor-status').props.children).toBe('unrecorded');
    expect(screen.getByTestId('stub-feed-status').props.children).toBe('ready');
  });

  it('tells the panel a settled feed is settled, so an empty one reads as genuinely empty', async () => {
    mockReflectionsSources.mockResolvedValueOnce({
      items: [],
      level: 'stage',
      scope_key: 'c1:s1',
      window_start: '2026-06-01T04:00:00Z',
      window_end: '2026-06-22T04:00:00Z',
      anchor_status: 'recorded',
    });
    const screen = renderScreen(REFLECTION_PARAMS);
    await act(async () => {
      fireEvent.press(await screen.findByTestId('reflection-sources-toggle'));
    });

    expect(screen.getByTestId('stub-feed-status').props.children).toBe('ready');
    expect(screen.getByTestId('stub-anchor-status').props.children).toBe('recorded');
  });

  it('tells the panel the feed FAILED rather than letting a refusal read as an empty period', async () => {
    // A 403, a 500 and an offline device all land here. None of them is
    // evidence that the writer wrote nothing.
    mockReflectionsSources.mockRejectedValueOnce(new Error('offline'));
    const screen = renderScreen(REFLECTION_PARAMS);
    await act(async () => {
      fireEvent.press(await screen.findByTestId('reflection-sources-toggle'));
    });

    expect(screen.getByTestId('stub-feed-status').props.children).toBe('failed');
    expect(screen.getByTestId('stub-source-ids').props.children).toBe('');
  });

  it('tells the panel the feed is still LOADING while the request is in flight', async () => {
    let settle: ((_value: ReflectionSourcesResponse) => void) | undefined;
    mockReflectionsSources.mockReturnValueOnce(
      new Promise<ReflectionSourcesResponse>((resolve) => {
        settle = resolve;
      }),
    );
    const screen = renderScreen(REFLECTION_PARAMS);
    await act(async () => {
      fireEvent.press(await screen.findByTestId('reflection-sources-toggle'));
    });

    expect(screen.getByTestId('stub-feed-status').props.children).toBe('loading');

    await act(async () => {
      settle?.({ items: [], anchor_status: 'recorded', window_start: null, window_end: null });
      await Promise.resolve();
    });
    expect(screen.getByTestId('stub-feed-status').props.children).toBe('ready');
  });
});

// #2885: the batch fold-in reaches the panel, and a failed mark offers a retry
// that re-marks only what failed, from the composer hint every path can see.
describe('JournalEntryScreen -- batch fold-in and its retry (#2885)', () => {
  const { inclusionRetryHint } = require('../quoteFoldCopy') as {
    inclusionRetryHint: (_n: number) => string;
  };

  async function foldBatch(findByTestId: (_id: string) => Promise<unknown>): Promise<void> {
    await act(async () => {
      fireEvent.press((await findByTestId('reflection-sources-toggle')) as never);
    });
    await act(async () => {
      fireEvent.press((await findByTestId('stub-insert-batch')) as never);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(100);
    });
  }

  it('folds a batch as one entry write and one mark per quote, then shows both folded', async () => {
    mockReflectionsSources.mockResolvedValue({ items: [mockTwoQuoteSource] });
    jest.useFakeTimers();
    try {
      const { findByTestId, getByTestId } = renderScreen(REFLECTION_PARAMS, {
        autosaveDelayMs: 100,
      });
      await foldBatch(findByTestId);
      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(mockSetIncluded.mock.calls).toEqual([
        [90, 42],
        [91, 42],
      ]);
      expect(getByTestId('stub-folded-ids').props.children).toBe('90,91');
    } finally {
      jest.useRealTimers();
    }
  });

  it('names how many marks failed, and Try again re-marks only those', async () => {
    mockReflectionsSources.mockResolvedValue({ items: [mockTwoQuoteSource] });
    mockSetIncluded.mockImplementation((id) =>
      id === 91 ? Promise.reject({ status: 500 }) : Promise.resolve(mockStubQuote),
    );
    jest.useFakeTimers();
    try {
      const { findByTestId, getByTestId, getByLabelText, queryByTestId } = renderScreen(
        REFLECTION_PARAMS,
        { autosaveDelayMs: 100 },
      );
      await foldBatch(findByTestId);
      expect(getByTestId('quote-inclusion-hint-text').props.children).toBe(inclusionRetryHint(1));
      const retry = getByLabelText('Try again');
      expect(retry.props.accessibilityRole).toBe('button');

      mockSetIncluded.mockReset();
      mockSetIncluded.mockResolvedValue(mockStubQuote);
      await act(async () => {
        fireEvent.press(retry);
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      expect(mockSetIncluded.mock.calls).toEqual([[91, 42]]);
      expect(queryByTestId('quote-inclusion-hint')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});

// #2754: the inclusion warning is per quote. A tap on A whose mark fails and an
// overlapping tap on B whose mark lands leave the warning up for A alone, and
// Try again re-marks A only. A quote removed elsewhere meanwhile (its PATCH
// 404s promotion_not_found) retires from the warning and from the panel.
describe('JournalEntryScreen -- a per-quote inclusion warning (#2754)', () => {
  const { inclusionRetryHint } = require('../quoteFoldCopy') as {
    inclusionRetryHint: (_n: number) => string;
  };

  /** Tap 90 then 91 with both marks held, and settle them in ``order``. */
  async function overlapThenSettle(
    screen: ReturnType<typeof renderScreen>,
    order: readonly number[],
  ): Promise<void> {
    const settle = new Map<number, () => void>();
    mockSetIncluded.mockImplementation(
      (id: number) =>
        new Promise<unknown>((resolve, reject) => {
          settle.set(id, () =>
            id === 90 ? reject({ status: 500, detail: 'boom' }) : resolve(mockSecondQuote),
          );
        }),
    );
    await act(async () => {
      fireEvent.press(await screen.findByTestId('reflection-sources-toggle'));
    });
    await act(async () => {
      fireEvent.press(await screen.findByTestId('stub-insert-quote-90'));
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(100);
    });
    await act(async () => {
      fireEvent.press(await screen.findByTestId('stub-insert-quote-91'));
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(100);
    });
    expect([...settle.keys()]).toEqual([90, 91]);
    for (const id of order) {
      await act(async () => {
        settle.get(id)?.();
        await jest.advanceTimersByTimeAsync(0);
      });
    }
  }

  async function pressRetry(screen: ReturnType<typeof renderScreen>): Promise<void> {
    await act(async () => {
      fireEvent.press(screen.getByTestId('quote-inclusion-retry'));
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(100);
    });
  }

  it.each([
    ['A settles last', [91, 90]],
    ['B settles last', [90, 91]],
  ])(
    "keeps A's warning through B's overlapping success (%s), and Try again PATCHes only A",
    async (_order, order) => {
      mockReflectionsSources.mockResolvedValue({ items: [mockTwoQuoteSource] });
      jest.useFakeTimers();
      try {
        const screen = renderScreen(REFLECTION_PARAMS, { autosaveDelayMs: 100 });
        await overlapThenSettle(screen, order);
        expect(screen.getByTestId('quote-inclusion-hint-text').props.children).toBe(
          inclusionRetryHint(1),
        );
        expect(screen.getByTestId('stub-folded-ids').props.children).toBe('91');

        mockSetIncluded.mockReset();
        mockSetIncluded.mockResolvedValue(mockStubQuote);
        await pressRetry(screen);
        expect(mockSetIncluded.mock.calls).toEqual([[90, 42]]);
        expect(screen.queryByTestId('quote-inclusion-hint')).toBeNull();
        expect(screen.getByTestId('stub-folded-ids').props.children).toBe('91,90');
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('retires the warning and the pending row when the retry finds the quote removed', async () => {
    mockReflectionsSources.mockResolvedValue({ items: [mockTwoQuoteSource] });
    jest.useFakeTimers();
    try {
      const screen = renderScreen(REFLECTION_PARAMS, { autosaveDelayMs: 100 });
      await overlapThenSettle(screen, [91, 90]);
      expect(screen.getByTestId('stub-pending-ids').props.children).toBe('90,91');

      mockSetIncluded.mockReset();
      mockSetIncluded.mockRejectedValue({ status: 404, detail: 'promotion_not_found' });
      await pressRetry(screen);
      expect(mockSetIncluded.mock.calls).toEqual([[90, 42]]);
      expect(screen.queryByTestId('quote-inclusion-hint')).toBeNull();
      expect(screen.getByTestId('stub-pending-ids').props.children).toBe('91');
      expect(screen.getByTestId('stub-folded-ids').props.children).toBe('91');
    } finally {
      jest.useRealTimers();
    }
  });
});

// #2885: a review opened FOR a selection from the Promoted quotes screen folds
// that selection in once -- into the body it actually has.
describe('JournalEntryScreen -- a selection handed over from Promoted quotes (#2885)', () => {
  const { usePromotedQuoteHandoffStore } = require('@/store/usePromotedQuoteHandoffStore') as {
    usePromotedQuoteHandoffStore: {
      getState: () => {
        open: () => string;
        deliver: (_t: string, _c: unknown[]) => void;
        clear: () => void;
        pending: unknown;
      };
    };
  };
  const HANDED = [
    { id: 90, anchorText: 'went for a daily walk', attribution: 'Runs' },
    { id: 91, anchorText: 'to the river', attribution: 'Runs' },
  ];
  const BLOCKS = '> went for a daily walk\n> — Runs\n\n> to the river\n> — Runs\n\n';

  function handOver(): string {
    const handoff = usePromotedQuoteHandoffStore.getState();
    let token = '';
    act(() => {
      token = handoff.open();
      handoff.deliver(token, HANDED);
    });
    return token;
  }

  beforeEach(() => {
    act(() => usePromotedQuoteHandoffStore.getState().clear());
  });

  it('folds the selection into a fresh review once, and marks each quote once', async () => {
    const token = handOver();
    jest.useFakeTimers();
    try {
      renderScreen(
        { ...REFLECTION_PARAMS, injectQuotes: token },
        {
          autosaveDelayMs: 100,
        },
      );
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ message: BLOCKS }), KEYED);
      // Later renders and saves fold nothing more.
      await act(async () => {
        await jest.advanceTimersByTimeAsync(500);
      });
      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(mockSetIncluded.mock.calls).toEqual([
        [90, 42],
        [91, 42],
      ]);
      expect(usePromotedQuoteHandoffStore.getState().pending).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('waits for a continued review to load, then folds into the body it loaded', async () => {
    mockGet.mockResolvedValue(
      entry({
        id: 42,
        message: 'What I wrote on Monday.',
        tag: 'hierarchical_reflection' as JournalMessage['tag'],
        reflection_level: 'week',
        reflection_scope_key: 'c1:w1',
      }),
    );
    const token = handOver();
    jest.useFakeTimers();
    try {
      renderScreen({ entryId: 42, injectQuotes: token }, { autosaveDelayMs: 100 });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      expect(mockUpdate).toHaveBeenCalledWith(
        42,
        expect.objectContaining({ message: `What I wrote on Monday.\n\n${BLOCKS}` }),
      );
      expect(mockSetIncluded).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('ignores a selection handed to another page', async () => {
    handOver();
    jest.useFakeTimers();
    try {
      renderScreen(
        { ...REFLECTION_PARAMS, injectQuotes: 'quotes-not-mine' },
        {
          autosaveDelayMs: 100,
        },
      );
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockSetIncluded).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});

// Phase C review of #2885: a fold marks a quote included on the review only
// once the review's body -- the one holding the quote's words -- is durable.
describe('JournalEntryScreen -- no inclusion mark over a failed review write (#2885)', () => {
  const { inclusionRetryHint } = require('../quoteFoldCopy') as {
    inclusionRetryHint: (_n: number) => string;
  };

  function openExistingReview() {
    mockGet.mockResolvedValue(
      entry({
        id: 42,
        message: 'What I wrote on Monday.',
        tag: 'hierarchical_reflection' as JournalMessage['tag'],
        reflection_level: 'week',
        reflection_scope_key: 'c1:w1',
      }),
    );
    mockReflectionsSources.mockResolvedValue({ items: [mockTwoQuoteSource] });
    return renderScreen({ entryId: 42 }, { autosaveDelayMs: 100 });
  }

  /** Let the review load (fake timers hold its promises until advanced). */
  async function hydrate(): Promise<void> {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
  }

  it('sends no PATCH when the body write fails, keeps every quote retryable, and retry re-saves first', async () => {
    mockUpdate.mockRejectedValue({ status: 500, detail: 'boom' });
    jest.useFakeTimers();
    try {
      const { findByTestId, getByTestId, getByLabelText } = openExistingReview();
      await hydrate();
      await act(async () => {
        fireEvent.press(await findByTestId('reflection-sources-toggle'));
      });
      await act(async () => {
        fireEvent.press(await findByTestId('stub-insert-batch'));
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      expect(mockUpdate).toHaveBeenCalled();
      expect(mockSetIncluded).not.toHaveBeenCalled();
      expect(getByTestId('quote-inclusion-hint-text').props.children).toBe(inclusionRetryHint(2));

      mockUpdate.mockReset();
      mockUpdate.mockResolvedValue(entry({ id: 42 }));
      await act(async () => {
        fireEvent.press(getByLabelText('Try again'));
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      expect(mockUpdate).toHaveBeenCalledWith(
        42,
        expect.objectContaining({ message: expect.stringContaining('> to the river') }),
      );
      expect(mockSetIncluded.mock.calls).toEqual([
        [90, 42],
        [91, 42],
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a single tap sends no PATCH either when the body write fails', async () => {
    mockUpdate.mockRejectedValue({ status: 500, detail: 'boom' });
    jest.useFakeTimers();
    try {
      const { findByTestId } = openExistingReview();
      await hydrate();
      await act(async () => {
        fireEvent.press(await findByTestId('reflection-sources-toggle'));
      });
      await act(async () => {
        fireEvent.press(await findByTestId('stub-insert-quote'));
      });
      await act(async () => {
        await jest.advanceTimersByTimeAsync(100);
      });
      expect(mockUpdate).toHaveBeenCalled();
      expect(mockSetIncluded).not.toHaveBeenCalled();
      expect(await findByTestId('quote-inclusion-hint')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });
});
