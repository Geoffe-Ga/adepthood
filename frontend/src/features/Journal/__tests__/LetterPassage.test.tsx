/* eslint-env jest */
// #3660: a reader lifts a sentence from a letter their Higher Self wrote them
// the way they lift one from their own page. A quiet "Promote a quote" under
// the letter swaps it for the selection surface over the same words, the
// floating pill promotes the passage, and the letter comes back with the
// notice beneath it -- the card it sits in never closes.
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { act, fireEvent, render, within } from '@testing-library/react-native';
import React from 'react';

import { FLOATING_PROMOTE_TEST_ID } from '../FloatingPromoteButton';
import LetterPassage from '../LetterPassage';
import { PROMOTE_EXPLAINER_READING_BODY, PROMOTED_NOTICE_COPY } from '../promoteExplainerCopy';

import type { PromotedQuote } from '@/api';
import { ApiError } from '@/api';

type SpanCreate = (
  _marginaliaId: number,
  _span: { anchor_start: number; anchor_end: number },
) => Promise<PromotedQuote>;
const mockCreateForLetter = jest.fn() as jest.MockedFunction<SpanCreate>;
const mockListForLetter = jest.fn(() => Promise.resolve([] as PromotedQuote[]));
let mockDismissed = true;

jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api') as Record<string, unknown>;
  return {
    ...actual,
    promotions: {
      createForLetter: (...a: unknown[]) =>
        (mockCreateForLetter as unknown as (...x: unknown[]) => unknown)(...a),
      listForLetter: () => mockListForLetter(),
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

// An astral emoji first, so a slice by raw UTF-16 index would be off by one.
const ESSAY = '\u{1F338} The heron waits in the shallows until the light changes.';
const HERON_UTF16 = { start: ESSAY.indexOf('heron'), end: ESSAY.indexOf('heron') + 5 };
const HERON_POINTS = { anchor_start: HERON_UTF16.start - 1, anchor_end: HERON_UTF16.end - 1 };

function letterQuote(): PromotedQuote {
  return {
    id: 32,
    source_kind: 'letter',
    source_entry_id: null,
    source_content_id: null,
    source_marginalia_id: 9,
    ...HERON_POINTS,
    anchor_text: 'heron',
    pending: true,
    stale: false,
  };
}

type RenderResult = ReturnType<typeof render>;

async function renderLetter(): Promise<RenderResult> {
  const utils = render(
    <LetterPassage marginaliaId={9} essay={ESSAY} textTestID="essay-text">
      {null}
    </LetterPassage>,
  );
  // The explainer's stored flag is read on mount.
  await act(async () => {
    await Promise.resolve();
  });
  return utils;
}

async function openSelection(utils: RenderResult): Promise<void> {
  await act(async () => {
    fireEvent.press(utils.getByTestId('letter-promote-open'));
  });
}

function chooseHeron(utils: RenderResult): void {
  fireEvent(utils.getByTestId('letter-quote-select-input'), 'selectionChange', {
    nativeEvent: { selection: HERON_UTF16 },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDismissed = true;
  mockCreateForLetter.mockResolvedValue(letterQuote());
});

describe('LetterPassage -- reading', () => {
  it('shows the letter with a quiet way to promote a quote beneath it', async () => {
    const utils = await renderLetter();

    expect(utils.getByTestId('essay-text')).toHaveTextContent(ESSAY);
    const open = utils.getByTestId('letter-promote-open');
    within(open).getByText('Promote a quote');
    expect(open.props.accessibilityRole).toBe('button');
    expect(open.props.accessibilityLabel).toBe('Promote a quote from this letter');
  });

  it('reads no quotes when it opens: a letter is read with no request at all', async () => {
    await renderLetter();

    expect(mockListForLetter).not.toHaveBeenCalled();
  });
});

describe('LetterPassage -- promoting a passage', () => {
  it('swaps the letter for the selection surface over the same words', async () => {
    const utils = await renderLetter();
    await openSelection(utils);

    expect(utils.queryByTestId('essay-text')).toBeNull();
    expect(utils.getByTestId('letter-quote-select-input').props.value).toBe(ESSAY);
    expect(utils.queryByTestId('letter-promote-open')).toBeNull();
  });

  it('promotes the chosen passage in code points over the letter route', async () => {
    const utils = await renderLetter();
    await openSelection(utils);
    chooseHeron(utils);

    const pill = utils.getByTestId(FLOATING_PROMOTE_TEST_ID);
    within(pill).getByText('Promote');
    expect(pill.props.accessibilityLabel).toBe('Promote this passage');
    await act(async () => {
      fireEvent.press(pill);
    });

    expect(mockCreateForLetter).toHaveBeenCalledWith(9, HERON_POINTS);
  });

  it('returns to the letter and says where the quote went', async () => {
    const utils = await renderLetter();
    await openSelection(utils);
    chooseHeron(utils);

    await act(async () => {
      fireEvent.press(utils.getByTestId(FLOATING_PROMOTE_TEST_ID));
    });

    expect(utils.getByTestId('essay-text')).toHaveTextContent(ESSAY);
    expect(utils.getByTestId('quote-promotion-success')).toHaveTextContent(PROMOTED_NOTICE_COPY);
  });

  it('says why a letter on an Intimate page stays put, and offers the same passage again', async () => {
    mockCreateForLetter.mockRejectedValueOnce(new ApiError(409, 'quote_source_restricted'));
    const utils = await renderLetter();
    await openSelection(utils);
    chooseHeron(utils);

    await act(async () => {
      fireEvent.press(utils.getByTestId(FLOATING_PROMOTE_TEST_ID));
    });

    expect(utils.getByTestId('quote-promotion-error')).toHaveTextContent(
      /page this letter answered is marked Intimate/,
    );
    await act(async () => {
      fireEvent.press(utils.getByTestId('quote-promotion-retry'));
    });
    expect(mockCreateForLetter).toHaveBeenLastCalledWith(9, HERON_POINTS);
  });

  it('goes back to the letter on Cancel with nothing promoted', async () => {
    const utils = await renderLetter();
    await openSelection(utils);
    chooseHeron(utils);

    fireEvent.press(utils.getByTestId('letter-quote-select-cancel'));

    expect(utils.getByTestId('essay-text')).toBeTruthy();
    expect(mockCreateForLetter).not.toHaveBeenCalled();
  });
});

describe('LetterPassage -- the first promote explains itself, inside the card', () => {
  it('sets the reading note in place of the letter, then goes on to choosing a passage', async () => {
    mockDismissed = false;
    const utils = await renderLetter();
    await openSelection(utils);

    expect(utils.queryByTestId('essay-text')).toBeNull();
    expect(utils.queryByTestId('promote-explainer-scrim')).toBeNull();
    expect(utils.getByTestId('promote-explainer-body')).toHaveTextContent(
      PROMOTE_EXPLAINER_READING_BODY,
    );

    fireEvent.press(utils.getByTestId('promote-explainer-continue'));

    expect(utils.getByTestId('letter-quote-select-input')).toBeTruthy();
  });

  it('returns to the letter on Not now', async () => {
    mockDismissed = false;
    const utils = await renderLetter();
    await openSelection(utils);

    fireEvent.press(utils.getByTestId('promote-explainer-cancel'));

    expect(utils.getByTestId('essay-text')).toBeTruthy();
    expect(utils.queryByTestId('letter-quote-select-input')).toBeNull();
  });
});
