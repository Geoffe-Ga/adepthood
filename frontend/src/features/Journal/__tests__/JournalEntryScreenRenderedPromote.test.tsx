/* eslint-env jest */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

/**
 * Journal read mode on the web: a passage highlighted right on the rendered
 * page brings the floating pill, and the pill promotes it (#3661).
 *
 * The browser half -- reading the document's selection over the rendered
 * runs -- is pinned by ``useRenderedSelection.test.tsx`` and
 * ``renderedSelection.test.ts`` and walked end to end by
 * ``journal-promote-quote-long-entry.browser.e2e.test.ts``. Here the hook
 * reports a chosen span by hand and the pill is a stand-in that draws on any
 * platform, so these specs are about the screen's wiring: which span goes up,
 * what the one-time note says first, and that the selection is let go.
 */
import type { AnchorSpan } from '../anchorSpan';

import type { JournalMessage, PromotedQuote } from '@/api';
import { setActiveUser } from '@/storage/userScope';

const mockGet = jest.fn() as jest.MockedFunction<(_id: number) => Promise<JournalMessage>>;
const mockPromote = jest.fn() as jest.MockedFunction<
  (_entryId: number, _span: { anchor_start: number; anchor_end: number }) => Promise<PromotedQuote>
>;
const mockClearSelection = jest.fn();
let mockSpan: AnchorSpan | null = null;

jest.mock('@/context/AuthContext', () => require('./authContextTestKit'));

jest.mock('@/api', () => ({
  ...require('./journalUiFlagsTestKit'),
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

jest.mock('../useRenderedSelection', () => ({
  useHighlightedPassage: () => mockSpan,
  clearRenderedSelection: () => mockClearSelection(),
}));

/** The pill, drawn on any platform: the real one draws only on the web. */
jest.mock('../RenderedSelectionPill', () => {
  const { Pressable, Text } = require('react-native');
  const StandIn = ({
    passage,
    onPromote,
    busy,
  }: {
    passage: AnchorSpan | null;
    onPromote: (_span: AnchorSpan) => void;
    busy?: boolean;
  }) =>
    passage ? (
      <Pressable
        testID="rendered-pill"
        onPress={() => onPromote(passage)}
        accessibilityState={{ busy }}
      >
        <Text>Promote selection</Text>
      </Pressable>
    ) : null;
  return { __esModule: true, default: StandIn, STEP_ASIDE: { opacity: 0 } };
});

const JournalEntryScreen = require('../JournalEntryScreen').default;

const BODY = 'A page about a daily run to the river and back.';
const PASSAGE = { start: 2, end: 19 };
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

function promoted(): PromotedQuote {
  return {
    id: 90,
    source_kind: 'entry',
    source_entry_id: 7,
    source_content_id: null,
    source_marginalia_id: null,
    anchor_start: PASSAGE.start,
    anchor_end: PASSAGE.end,
    anchor_text: Array.from(BODY).slice(PASSAGE.start, PASSAGE.end).join(''),
    pending: true,
    stale: false,
  };
}

function renderScreen() {
  const route = { key: 'k', name: 'JournalEntry' as const, params: { entryId: 7 } };
  const navigation = { navigate: jest.fn(), goBack: jest.fn(), push: jest.fn() };
  const Screen = JournalEntryScreen as unknown as React.ComponentType<Record<string, unknown>>;
  return render(<Screen navigation={navigation} route={route} />);
}

beforeEach(async () => {
  await AsyncStorage.clear();
  setActiveUser(ACCOUNT);
  mockGet.mockReset();
  mockGet.mockResolvedValue(entry());
  mockPromote.mockReset();
  mockPromote.mockResolvedValue(promoted());
  mockClearSelection.mockReset();
  mockSpan = null;
});

afterEach(() => {
  setActiveUser(null);
});

describe('JournalEntryScreen — promote by highlighting the rendered page (#3661)', () => {
  it('offers no pill while nothing is highlighted', async () => {
    const screen = renderScreen();
    await screen.findByTestId('journal-body-read');
    expect(screen.queryByTestId('rendered-pill')).toBeNull();
  });

  it('promotes exactly the highlighted span, lets the selection go, and confirms', async () => {
    await AsyncStorage.setItem(DISMISSED_KEY, 'true');
    mockSpan = PASSAGE;
    const screen = renderScreen();
    const pill = await screen.findByTestId('rendered-pill');
    await act(async () => {
      fireEvent.press(pill);
    });

    expect(mockPromote).toHaveBeenCalledWith(7, { anchor_start: 2, anchor_end: 19 });
    expect(mockClearSelection).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('quote-promotion-success')).toBeTruthy();
    // Read mode stays read mode: no selection field ever opened.
    expect(screen.queryByTestId('quote-select-input')).toBeNull();
  });

  it('a first promote explains itself for the passage already chosen, then promotes it', async () => {
    mockSpan = PASSAGE;
    const screen = renderScreen();
    fireEvent.press(await screen.findByTestId('rendered-pill'));

    expect(await screen.findByTestId('promote-explainer-dialog')).toBeTruthy();
    expect(screen.getByTestId('promote-explainer-continue')).toHaveTextContent(
      'Promote the passage',
    );
    expect(mockPromote).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.press(screen.getByTestId('promote-explainer-continue'));
    });
    expect(mockPromote).toHaveBeenCalledWith(7, { anchor_start: 2, anchor_end: 19 });
    expect(screen.queryByTestId('quote-select-input')).toBeNull();
  });

  it('steps the Promote a quote opener aside while the pill stands in for it', async () => {
    mockSpan = PASSAGE;
    const screen = renderScreen();
    await screen.findByTestId('rendered-pill');
    const row = screen.getByTestId('journal-read-actions', { includeHiddenElements: true });
    expect(StyleSheet.flatten(row.props.style).opacity).toBe(0);
    expect(row.props.pointerEvents).toBe('none');
    expect(screen.queryByTestId('promote-quote-button')).toBeNull();
  });

  it('Promote a quote still opens the selection field, its note worded for choosing a passage', async () => {
    const screen = renderScreen();
    expect(
      StyleSheet.flatten((await screen.findByTestId('journal-read-actions')).props.style).opacity,
    ).toBeUndefined();
    fireEvent.press(await screen.findByTestId('promote-quote-button'));
    expect(screen.getByTestId('promote-explainer-continue')).toHaveTextContent(
      'Choose the passage',
    );
    fireEvent.press(screen.getByTestId('promote-explainer-continue'));

    expect(screen.getByTestId('quote-select-input').props.value).toBe(BODY);
    expect(mockPromote).not.toHaveBeenCalled();
  });
});
