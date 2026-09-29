import { jest, describe, it, expect, beforeAll, beforeEach } from '@jest/globals';
import { fireEvent, render, within, type RenderResult } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

// #2418: margin notes sit beside the passages they annotate. Jest's node env
// never fires onLayout and has no DOM, so the measurement is injected here and
// the layout events are fired by hand; real geometry is pinned by the browser
// lane (e2e/journal-margin-alignment.browser.e2e.test.ts).
import { computeMarginSlots } from '../computeMarginSlots';

import { note, suggestion } from './resonanceTestKit';

import type { CompletionSuggestion, JournalMessage } from '@/api';
import { journalLayout } from '@/design/tokens';

const mockGet = jest.fn() as jest.MockedFunction<(_id: number) => Promise<JournalMessage>>;
const mockList = jest.fn() as jest.MockedFunction<(_id: number) => Promise<{ items: unknown[] }>>;
const mockCompletionList = jest.fn() as jest.MockedFunction<
  (_id: number) => Promise<{ items: CompletionSuggestion[] }>
>;
const mockMeasure = jest.fn() as jest.MockedFunction<
  (_stream: unknown, _ids: readonly number[]) => Map<number, number>
>;

jest.mock('@/context/AuthContext', () => require('./authContextTestKit'));

jest.mock('@/api', () => ({
  journal: {
    get: (...a: unknown[]) => (mockGet as unknown as (...x: unknown[]) => unknown)(...a),
    create: jest.fn(),
    update: jest.fn(),
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
    create: jest.fn(),
    remove: jest.fn(),
    setIncluded: jest.fn(),
    list: jest.fn(() => Promise.resolve([])),
  },
}));

jest.mock('@/features/Habits/services/habitManager', () => ({
  habitManager: { loadHabits: jest.fn(() => Promise.resolve()) },
}));

jest.mock('@/navigation/hooks', () => ({
  ...(jest.requireActual('@/navigation/hooks') as Record<string, unknown>),
  useAppNavigation: () => ({ navigate: jest.fn(), setOptions: jest.fn() }),
}));

jest.mock('@/context/ApiKeyContext', () => require('./apiKeyContextTestKit'));

jest.mock('../marginAnchorMeasure', () => ({
  measureAnchorTops: (...a: unknown[]) =>
    (mockMeasure as unknown as (...x: unknown[]) => unknown)(...a),
}));

const JournalEntryScreen = require('../JournalEntryScreen').default;

const BODY = 'A page about a daily run to the river and back.';
const GAP = journalLayout.marginNoteGap;
const NOTE_HEIGHT = 40;
const OFFER_HEIGHT = 60;
const STREAM_WIDTH = 180;
/** Where the fake measurement puts each drawn note's passage. */
const ANCHOR_TOPS = new Map([
  [1, 100],
  [2, 110],
]);

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

function renderScreen(): RenderResult {
  const route = { key: 'k', name: 'JournalEntry' as const, params: { entryId: 7 } };
  const navigation = { navigate: jest.fn(), goBack: jest.fn(), push: jest.fn() };
  const Screen = JournalEntryScreen as unknown as React.ComponentType<Record<string, unknown>>;
  return render(<Screen navigation={navigation} route={route} />);
}

function layout(height: number) {
  return { nativeEvent: { layout: { x: 0, y: 0, width: STREAM_WIDTH, height } } };
}

/** Report every slot's height, then the stream's own layout, as a browser would. */
function fireLayouts(view: RenderResult): void {
  fireEvent(view.getByTestId('margin-slot-note-1'), 'layout', layout(NOTE_HEIGHT));
  fireEvent(view.getByTestId('margin-slot-note-2'), 'layout', layout(NOTE_HEIGHT));
  fireEvent(view.getByTestId('margin-slot-suggestion-90'), 'layout', layout(OFFER_HEIGHT));
  fireEvent(view.getByTestId('journal-margin-stream'), 'layout', layout(0));
}

const flat = (view: RenderResult, testID: string) =>
  StyleSheet.flatten(view.getByTestId(testID).props.style);

const SLOT_IDS = ['margin-slot-note-1', 'margin-slot-note-2', 'margin-slot-suggestion-90'];

/** RNTL's own default wait for a findBy query. */
const DEFAULT_FIND_MS = 1000;

async function renderWithNotes(
  overrides: Partial<JournalMessage> = {},
  findTimeout = DEFAULT_FIND_MS,
): Promise<RenderResult> {
  mockGet.mockResolvedValue(entry(overrides));
  const view = renderScreen();
  await view.findByTestId('margin-note-2', {}, { timeout: findTimeout });
  await view.findByTestId('suggestion-90', {}, { timeout: findTimeout });
  return view;
}

function withWidth<T>(width: number, run: () => Promise<T>): Promise<T> {
  const rn = require('react-native');
  const spy = jest
    .spyOn(rn, 'useWindowDimensions')
    .mockReturnValue({ width, height: 800, scale: 1, fontScale: 1 });
  return run().finally(() => spy.mockRestore());
}

function arrangeColumn(): void {
  mockGet.mockReset();
  mockList.mockReset();
  mockList.mockResolvedValue({
    items: [
      // "page" (2-6) and "daily" (13-18): both drawn, so both are anchored.
      note({ id: 2, anchor_start: 13, anchor_end: 18, anchor_text: 'daily' }),
      note({ id: 1, anchor_start: 2, anchor_end: 6, anchor_text: 'page' }),
    ],
  });
  mockCompletionList.mockReset();
  mockCompletionList.mockResolvedValue({ items: [suggestion({ id: 90, anchor_start: 0 })] });
  mockMeasure.mockReset();
  mockMeasure.mockReturnValue(ANCHOR_TOPS);
}

/**
 * The screen's first render in a worker pays for every module it pulls in
 * lazily -- seconds on a cold, loaded machine -- which would otherwise be
 * billed to whichever test happens to run first and time it out. Paying it
 * once here, under its own generous budget, keeps each test timing only its
 * own behaviour.
 */
const WARM_UP_BUDGET_MS = 60_000;

beforeAll(async () => {
  arrangeColumn();
  const view = await renderWithNotes({}, WARM_UP_BUDGET_MS);
  view.unmount();
}, WARM_UP_BUDGET_MS);

beforeEach(arrangeColumn);

describe('JournalEntryScreen -- margin notes beside their passages (#2418)', () => {
  it('keeps the flow layout until the slots and stream have been measured', async () => {
    const view = await renderWithNotes();

    for (const id of SLOT_IDS) {
      expect(flat(view, id).position).not.toBe('absolute');
      expect(flat(view, id).marginBottom).toBe(GAP);
    }
    expect(flat(view, 'journal-margin-stream').height).toBeUndefined();
  });

  it('places each slot at the solver’s top and grows the stream to cover the last one', async () => {
    const view = await withWidth(1280, async () => {
      const rendered = await renderWithNotes();
      fireLayouts(rendered);
      return rendered;
    });

    // Note 2's passage (110) is within a note-height of note 1's (100), so it
    // is pushed down by exactly the gap; the suggestion trails below both.
    const offerTop = 100 + 2 * (NOTE_HEIGHT + GAP);
    const tops = [100, 100 + NOTE_HEIGHT + GAP, offerTop];
    expect(
      computeMarginSlots([100, 110, null], [NOTE_HEIGHT, NOTE_HEIGHT, OFFER_HEIGHT], GAP),
    ).toEqual(tops);
    expect(SLOT_IDS.map((id) => flat(view, id).position)).toEqual([
      'absolute',
      'absolute',
      'absolute',
    ]);
    expect(SLOT_IDS.map((id) => flat(view, id).top)).toEqual(tops);
    expect(flat(view, 'journal-margin-stream').height).toBe(offerTop + OFFER_HEIGHT);
    // Only the drawn notes are looked up, in document order.
    expect(mockMeasure).toHaveBeenLastCalledWith(expect.anything(), [1, 2]);
    // The suggestion trails the anchored notes in the tree, too.
    const column = within(view.getByTestId('journal-margin-column'));
    expect(
      column.queryAllByTestId(/^margin-slot-/).map((node) => String(node.props.testID)),
    ).toEqual(SLOT_IDS);
  });

  it('renders a note whose passage went unmeasured where it sits: in the tail', async () => {
    mockMeasure.mockReturnValue(new Map([[2, 100]]));
    const view = await withWidth(1280, async () => {
      const rendered = await renderWithNotes();
      fireLayouts(rendered);
      return rendered;
    });

    const column = within(view.getByTestId('journal-margin-column'));
    const order = column.queryAllByTestId(/^margin-slot-/).map((node) => String(node.props.testID));
    // Tree order (what a screen reader walks) is the order on screen.
    expect(order).toEqual([
      'margin-slot-note-2',
      'margin-slot-note-1',
      'margin-slot-suggestion-90',
    ]);
    expect(order.map((id) => flat(view, id).top)).toEqual([
      100,
      100 + NOTE_HEIGHT + GAP,
      100 + 2 * (NOTE_HEIGHT + GAP),
    ]);
  });

  it('re-measures when the page lays out again, so a reflowed body moves its notes', async () => {
    const view = await withWidth(1280, async () => {
      const rendered = await renderWithNotes();
      fireLayouts(rendered);
      // The writing reflows (a web font lands, the body column widens): the
      // passages move but the margin stream keeps its size, so only the page's
      // own layout can say so.
      mockMeasure.mockReturnValue(
        new Map([
          [1, 400],
          [2, 700],
        ]),
      );
      fireEvent(rendered.getByTestId('journal-page'), 'layout', layout(0));
      return rendered;
    });

    expect(SLOT_IDS.map((id) => flat(view, id).top)).toEqual([400, 700, 700 + NOTE_HEIGHT + GAP]);
  });

  it('re-measures when something above the notes appears, though nothing resizes', async () => {
    const view = await withWidth(1280, async () => {
      const rendered = await renderWithNotes();
      fireLayouts(rendered);
      // A banner mounts above the stream: the stream moves down, so every
      // passage now sits higher relative to it -- but only the head grew.
      mockMeasure.mockReturnValue(
        new Map([
          [1, 20],
          [2, 300],
        ]),
      );
      const head = rendered.getByTestId('journal-margin-head');
      // Its own handler, not one it would bubble up to: fireEvent walks up to
      // the page's onLayout otherwise, and a head nobody observes would pass.
      expect(head.props.onLayout).toEqual(expect.any(Function));
      fireEvent(head, 'layout', layout(OFFER_HEIGHT));
      return rendered;
    });

    expect(SLOT_IDS.map((id) => flat(view, id).top)).toEqual([20, 300, 300 + NOTE_HEIGHT + GAP]);
  });

  it('drops back to the flow when a wide page turns narrow after aligning', async () => {
    const rn = require('react-native');
    const spy = jest
      .spyOn(rn, 'useWindowDimensions')
      .mockReturnValue({ width: 1280, height: 800, scale: 1, fontScale: 1 });
    try {
      const view = await renderWithNotes();
      fireLayouts(view);
      expect(flat(view, 'margin-slot-note-1').position).toBe('absolute');

      spy.mockReturnValue({ width: 400, height: 800, scale: 1, fontScale: 1 });
      const route = { key: 'k', name: 'JournalEntry' as const, params: { entryId: 7 } };
      const Screen = JournalEntryScreen as unknown as React.ComponentType<Record<string, unknown>>;
      view.rerender(<Screen navigation={{ navigate: jest.fn() }} route={route} />);

      for (const id of SLOT_IDS) expect(flat(view, id).position).not.toBe('absolute');
    } finally {
      spy.mockRestore();
    }
  });

  it('stays in document-order flow on a narrow, stacked page', async () => {
    const view = await withWidth(400, async () => {
      const rendered = await renderWithNotes();
      fireLayouts(rendered);
      return rendered;
    });

    for (const id of SLOT_IDS) expect(flat(view, id).position).not.toBe('absolute');
    expect(flat(view, 'journal-margin-stream').height).toBeUndefined();
  });

  it('stays in flow while editing, when no highlight is drawn to sit beside', async () => {
    const view = await withWidth(1280, async () => {
      const rendered = await renderWithNotes({ status: 'draft' });
      fireLayouts(rendered);
      return rendered;
    });

    for (const id of SLOT_IDS) expect(flat(view, id).position).not.toBe('absolute');
  });
});
