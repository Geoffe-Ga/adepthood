/* eslint-env jest */
// #3661: on the web a reader highlights a sentence of a letter right where it
// reads, and the floating pill promotes it -- no selection field in between.
// The hook is stood in for (its browser half is pinned by
// useRenderedSelection.test.tsx), and so is the pill, which draws only on the
// web; these specs pin the letter's wiring.
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import type { AnchorSpan } from '../anchorSpan';
import LetterPassage from '../LetterPassage';
import { PROMOTED_NOTICE_COPY } from '../promoteExplainerCopy';
import type { RenderedSelection } from '../renderedSelection';

import type { PromotedQuote } from '@/api';

type SpanCreate = (
  _marginaliaId: number,
  _span: { anchor_start: number; anchor_end: number },
) => Promise<PromotedQuote>;
const mockCreateForLetter = jest.fn() as jest.MockedFunction<SpanCreate>;
const mockClearSelection = jest.fn();
let mockDismissed = true;
let mockSpan: AnchorSpan | null = null;
let mockToSourceSpan:
  ((_source: string, _selection: RenderedSelection) => AnchorSpan | null) | null = null;
let mockSource: string | null = null;
let mockContainer: { current: unknown } | null = null;

jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api') as Record<string, unknown>;
  return {
    ...actual,
    promotions: {
      createForLetter: (...a: unknown[]) =>
        (mockCreateForLetter as unknown as (...x: unknown[]) => unknown)(...a),
      listForLetter: () => Promise.resolve([]),
    },
  };
});

jest.mock('@/storage/promoteExplainerStorage', () => ({
  loadPromoteExplainerDismissed: () => Promise.resolve(mockDismissed),
  savePromoteExplainerDismissed: () => Promise.resolve(),
}));

jest.mock('../webSelectionListener', () => ({
  useWebSelectionListener: jest.fn(),
  useInitialFieldSelection: jest.fn(),
}));

jest.mock('../useRenderedSelection', () => ({
  useHighlightedPassage: (
    container: { current: unknown },
    source: string,
    toSourceSpan: (_source: string, _selection: RenderedSelection) => AnchorSpan | null,
  ) => {
    mockContainer = container;
    mockSource = source;
    mockToSourceSpan = toSourceSpan;
    return mockSpan;
  },
  clearRenderedSelection: () => mockClearSelection(),
}));

/** The pill, drawn on any platform: the real one draws only on the web. */
jest.mock('../RenderedSelectionPill', () => {
  const { Pressable, Text } = require('react-native');
  const StandIn = ({
    passage,
    onPromote,
    label,
    accessibilityLabel,
  }: {
    passage: AnchorSpan | null;
    onPromote: (_span: AnchorSpan) => void;
    label?: string;
    accessibilityLabel?: string;
  }) =>
    passage ? (
      <Pressable
        testID="rendered-pill"
        onPress={() => onPromote(passage)}
        accessibilityLabel={accessibilityLabel}
      >
        <Text>{label}</Text>
      </Pressable>
    ) : null;
  return { __esModule: true, default: StandIn, STEP_ASIDE: { opacity: 0 } };
});

// An astral emoji first, so a span read by raw UTF-16 index would be off by one.
const ESSAY = '\u{1F338} The heron waits in the shallows until the light changes.';
/** 'heron' in code points: the emoji is one, then a space and 'The '. */
const HERON = { start: 6, end: 11 };

function letterQuote(): PromotedQuote {
  return {
    id: 32,
    source_kind: 'letter',
    source_entry_id: null,
    source_content_id: null,
    source_marginalia_id: 9,
    anchor_start: HERON.start,
    anchor_end: HERON.end,
    anchor_text: 'heron',
    pending: true,
    stale: false,
  };
}

async function renderLetter(): Promise<ReturnType<typeof render>> {
  const utils = render(
    <LetterPassage marginaliaId={9} essay={ESSAY} textTestID="essay-text">
      {null}
    </LetterPassage>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  return utils;
}

beforeEach(() => {
  mockCreateForLetter.mockReset();
  mockCreateForLetter.mockResolvedValue(letterQuote());
  mockClearSelection.mockReset();
  mockDismissed = true;
  mockSpan = null;
  mockToSourceSpan = null;
  mockContainer = null;
  mockSource = null;
});

describe('LetterPassage — promote by highlighting the letter (#3661)', () => {
  it('reads the selection inside the letter text, mapped back to the essay itself', async () => {
    await renderLetter();
    // The letter's own text is the container: the ref is attached once it renders.
    expect(mockContainer?.current).toBeTruthy();
    const heron = ESSAY.indexOf('heron');
    expect(mockSource).toBe(ESSAY);
    const span = mockToSourceSpan?.(ESSAY, {
      pieces: [{ text: ESSAY, srcStart: null }],
      start: { piece: 0, offset: heron },
      end: { piece: 0, offset: heron + 'heron'.length },
    });
    expect(span).toEqual(HERON);
  });

  it('offers no pill while nothing in the letter is highlighted', async () => {
    const utils = await renderLetter();
    expect(utils.queryByTestId('rendered-pill')).toBeNull();
  });

  it('promotes the highlighted passage in code points, lets it go, and keeps the letter in view', async () => {
    mockSpan = HERON;
    const utils = await renderLetter();
    const pill = utils.getByTestId('rendered-pill');
    expect(pill.props.accessibilityLabel).toBe('Promote this passage');
    expect(utils.getByText('Promote')).toBeTruthy();
    await act(async () => {
      fireEvent.press(pill);
    });

    expect(mockCreateForLetter).toHaveBeenCalledWith(9, { anchor_start: 6, anchor_end: 11 });
    expect(mockClearSelection).toHaveBeenCalledTimes(1);
    expect(utils.getByTestId('essay-text')).toBeTruthy();
    expect(utils.getByTestId('quote-promotion-success')).toHaveTextContent(PROMOTED_NOTICE_COPY);
  });

  it('a first promote sets the note in the card for the passage already chosen, then promotes it', async () => {
    mockDismissed = false;
    mockSpan = HERON;
    const utils = await renderLetter();
    fireEvent.press(utils.getByTestId('rendered-pill'));

    expect(utils.getByTestId('promote-explainer-panel')).toBeTruthy();
    expect(utils.getByTestId('promote-explainer-continue')).toHaveTextContent(
      'Promote the passage',
    );
    expect(mockCreateForLetter).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.press(utils.getByTestId('promote-explainer-continue'));
    });
    expect(mockCreateForLetter).toHaveBeenCalledWith(9, { anchor_start: 6, anchor_end: 11 });
    expect(utils.getByTestId('essay-text')).toBeTruthy();
    expect(utils.queryByTestId('letter-quote-select-input')).toBeNull();
  });

  it('steps Promote a quote aside while the pill stands in for it', async () => {
    mockSpan = HERON;
    const utils = await renderLetter();
    const link = utils.getByTestId('letter-promote-open', { includeHiddenElements: true });
    expect(StyleSheet.flatten(link.props.style).opacity).toBe(0);
    expect(utils.queryByTestId('letter-promote-open')).toBeNull();
  });

  it('keeps Promote a quote as the way to choose a passage', async () => {
    const utils = await renderLetter();
    await act(async () => {
      fireEvent.press(utils.getByTestId('letter-promote-open'));
    });

    expect(utils.getByTestId('letter-quote-select-input').props.value).toBe(ESSAY);
  });
});
