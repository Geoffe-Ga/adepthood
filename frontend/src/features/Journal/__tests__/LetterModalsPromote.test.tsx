/* eslint-env jest */
// #3660: both places a reader meets a Resonance Letter -- the essay modal
// over the page it answered, and the Voice drafts shelf's letter -- offer
// "Promote a quote" under a real letter, and only under one. Promoting keeps
// the card open and shows the shared notice in it.
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import { FLOATING_PROMOTE_TEST_ID } from '../FloatingPromoteButton';
import { PROMOTED_NOTICE_COPY } from '../promoteExplainerCopy';

import type { Marginalia, PromotedQuote } from '@/api';
import { setActiveUser } from '@/storage/userScope';

type SpanCreate = (
  _marginaliaId: number,
  _span: { anchor_start: number; anchor_end: number },
) => Promise<PromotedQuote>;
const mockCreateForLetter = jest.fn() as jest.MockedFunction<SpanCreate>;
const mockEssay = jest.fn() as jest.MockedFunction<(_id: number) => Promise<Marginalia>>;
const mockList = jest.fn<(..._args: unknown[]) => Promise<unknown>>();
const mockNavigate = jest.fn();

jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api') as Record<string, unknown>;
  return {
    ...actual,
    resonance: {
      essay: (...a: unknown[]) => (mockEssay as unknown as (...x: unknown[]) => unknown)(...a),
    },
    botmasonUsage: {
      get: () =>
        Promise.resolve({
          monthly_messages_used: 0,
          monthly_messages_remaining: 20,
          monthly_cap: 20,
          monthly_reset_date: '2026-12-01T00:00:00Z',
          offering_balance: 0,
          resonance_route: 'app_provider',
        }),
    },
    voiceDrafts: { list: (...a: unknown[]) => mockList(...a) },
    promotions: {
      createForLetter: (...a: unknown[]) =>
        (mockCreateForLetter as unknown as (...x: unknown[]) => unknown)(...a),
    },
  };
});

// One object for every render: the payment scope is keyed by its identity.
const mockAuthState = {
  token: 'test.eyJzdWIiOiIxIiwiZXhwIjo0MTAyNDQ0ODAwfQ.test',
  authStatus: 'authenticated',
};
jest.mock('@/context/AuthContext', () => ({ useAuth: () => mockAuthState }));

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

jest.mock('@/storage/promoteExplainerStorage', () => ({
  loadPromoteExplainerDismissed: () => Promise.resolve(true),
  savePromoteExplainerDismissed: () => Promise.resolve(),
}));

jest.mock('../webSelectionListener', () => ({
  useWebSelectionListener: jest.fn(),
  useInitialFieldSelection: jest.fn(),
}));

const ResonanceEssayModal = require('../ResonanceEssayModal').default;
const VoiceDraftsShelfScreen = require('../VoiceDraftsShelfScreen').default;

const LETTER = 'The river keeps its own counsel, and so may you.';
const RIVER = { start: LETTER.indexOf('river'), end: LETTER.indexOf('river') + 5 };

function note(overrides: Partial<Marginalia> = {}): Marginalia {
  return {
    id: 9,
    journal_entry_id: 7,
    kind: 'connection',
    anchor_start: 0,
    anchor_end: 5,
    anchor_text: 'river',
    note: 'It runs.',
    essay: null,
    essay_generated_at: null,
    status: 'active',
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

function letterQuote(): PromotedQuote {
  return {
    id: 40,
    source_kind: 'letter',
    source_entry_id: null,
    source_content_id: null,
    source_marginalia_id: 9,
    anchor_start: RIVER.start,
    anchor_end: RIVER.end,
    anchor_text: 'river',
    pending: true,
    stale: false,
  };
}

type RenderResult = ReturnType<typeof render>;

/** Open the letter's selection, choose "river", press the pill. */
async function promoteRiver(utils: RenderResult): Promise<void> {
  await act(async () => {
    fireEvent.press(utils.getByTestId('letter-promote-open'));
  });
  fireEvent(utils.getByTestId('letter-quote-select-input'), 'selectionChange', {
    nativeEvent: { selection: RIVER },
  });
  await act(async () => {
    fireEvent.press(utils.getByTestId(FLOATING_PROMOTE_TEST_ID));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  setActiveUser(1);
  mockCreateForLetter.mockResolvedValue(letterQuote());
});

describe('ResonanceEssayModal -- Promote a quote', () => {
  it('offers it under a letter already written, after the line naming who wrote it', async () => {
    const utils = render(
      <ResonanceEssayModal note={note({ essay: LETTER })} onClose={jest.fn()} hasOwnKey />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(utils.getByTestId('essay-text')).toHaveTextContent(LETTER);
    expect(utils.getByTestId('essay-source')).toBeTruthy();
    expect(utils.getByTestId('letter-promote-open')).toBeTruthy();
  });

  it('is not offered on the priced offer for a letter not yet written', async () => {
    const utils = render(<ResonanceEssayModal note={note()} onClose={jest.fn()} hasOwnKey />);

    await utils.findByTestId('essay-offer');
    expect(utils.queryByTestId('letter-promote-open')).toBeNull();
  });

  it('is not offered while the letter is being written, nor on the care a vault sends instead', async () => {
    let answer: (_value: Marginalia) => void = () => undefined;
    mockEssay.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const utils = render(<ResonanceEssayModal note={note()} onClose={jest.fn()} hasOwnKey />);
    const ask = await utils.findByTestId('essay-ask');
    await act(async () => {
      fireEvent.press(ask);
    });
    expect(utils.getByTestId('essay-loading')).toBeTruthy();
    expect(utils.queryByTestId('letter-promote-open')).toBeNull();

    await act(async () => {
      answer({
        ...note(),
        care: { title: 'Care', message: 'Reviewed care.', resources: [] },
      } as unknown as Marginalia);
    });

    await utils.findByTestId('care-support-card');
    expect(utils.queryByTestId('letter-promote-open')).toBeNull();
  });

  it('promotes a passage of the letter and keeps the card open with the notice', async () => {
    const onClose = jest.fn();
    const utils = render(
      <ResonanceEssayModal note={note({ essay: LETTER })} onClose={onClose} hasOwnKey />,
    );
    await act(async () => {
      await Promise.resolve();
    });

    await promoteRiver(utils);

    expect(mockCreateForLetter).toHaveBeenCalledWith(9, {
      anchor_start: RIVER.start,
      anchor_end: RIVER.end,
    });
    expect(utils.getByTestId('essay-modal')).toBeTruthy();
    expect(utils.getByTestId('quote-promotion-success')).toHaveTextContent(PROMOTED_NOTICE_COPY);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('VoiceDraftsShelfScreen -- Promote a quote from a letter on the shelf', () => {
  const DRAFT = {
    marginalia_id: 9,
    journal_entry_id: 7,
    kind: 'theme',
    anchor_text: 'river',
    essay: LETTER,
    essay_generated_at: '2026-06-01T00:00:00Z',
  };

  it('promotes a passage of the opened letter and keeps the letter open', async () => {
    mockList.mockResolvedValue({ items: [DRAFT], total: 1, has_more: false });
    const utils = render(<VoiceDraftsShelfScreen />);
    fireEvent.press(await utils.findByTestId('voice-draft-9'));
    expect(utils.getByTestId('voice-draft-letter-text')).toHaveTextContent(LETTER);

    await promoteRiver(utils);

    expect(mockCreateForLetter).toHaveBeenCalledWith(9, {
      anchor_start: RIVER.start,
      anchor_end: RIVER.end,
    });
    await waitFor(() =>
      expect(utils.getByTestId('quote-promotion-success')).toHaveTextContent(PROMOTED_NOTICE_COPY),
    );
    expect(utils.getByTestId('voice-draft-letter-text')).toBeTruthy();
    expect(utils.getByTestId('voice-draft-letter')).toBeTruthy();
  });

  it('starts each letter afresh: another letter opens on its text, not the last one’s selection', async () => {
    mockList.mockResolvedValue({
      items: [DRAFT, { ...DRAFT, marginalia_id: 10, essay: 'A second letter.' }],
      total: 2,
      has_more: false,
    });
    const utils = render(<VoiceDraftsShelfScreen />);
    fireEvent.press(await utils.findByTestId('voice-draft-9'));
    await act(async () => {
      fireEvent.press(utils.getByTestId('letter-promote-open'));
    });
    fireEvent.press(utils.getByTestId('voice-draft-close'));

    fireEvent.press(utils.getByTestId('voice-draft-10'));

    expect(utils.getByTestId('voice-draft-letter-text')).toHaveTextContent('A second letter.');
    expect(utils.queryByTestId('letter-quote-select-input')).toBeNull();
  });
});
