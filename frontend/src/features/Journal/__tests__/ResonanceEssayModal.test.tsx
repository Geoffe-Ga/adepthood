/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import type { Marginalia } from '@/api';
import { ApiError } from '@/api';
import type { BotmasonUsageT as UsageResponse } from '@/api/schemas';

const mockEssay = jest.fn() as jest.MockedFunction<
  (_id: number, _options?: { priceAcknowledged?: boolean }) => Promise<Marginalia>
>;
const mockUsage = jest.fn() as jest.MockedFunction<() => Promise<UsageResponse>>;

jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api') as Record<string, unknown>;
  return {
    ...actual,
    resonance: {
      essay: (...a: unknown[]) => (mockEssay as unknown as (...x: unknown[]) => unknown)(...a),
    },
    botmasonUsage: {
      get: () => mockUsage(),
    },
  };
});

const ResonanceEssayModal = require('../ResonanceEssayModal').default;

function note(overrides: Partial<Marginalia> = {}): Marginalia {
  return {
    id: 4,
    journal_entry_id: 1,
    kind: 'connection',
    anchor_start: 0,
    anchor_end: 6,
    anchor_text: 'willow',
    note: 'It bends.',
    essay: null,
    essay_generated_at: null,
    status: 'active',
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

/** A usage read for an account with ``remaining`` of ``cap`` monthly messages left. */
function usage(cap: number, remaining: number, offerings = 0): UsageResponse {
  return {
    monthly_messages_used: cap - remaining,
    monthly_messages_remaining: remaining,
    monthly_cap: cap,
    monthly_reset_date: '2026-10-01T00:00:00Z',
    offering_balance: offerings,
  };
}

/** Press the offer's explicit, priced ask, and let the answer settle. */
async function askForTheLetter(findByTestId: (_id: string) => Promise<unknown>): Promise<void> {
  const ask = (await findByTestId('essay-ask')) as Parameters<typeof fireEvent.press>[0];
  await act(async () => {
    fireEvent.press(ask);
  });
}

beforeEach(() => {
  mockEssay.mockReset();
  mockUsage.mockReset();
  mockUsage.mockRejectedValue(new Error('usage unavailable in this test'));
});

describe('ResonanceEssayModal', () => {
  it('asks for the letter once, price acknowledged, only when the writer asks', async () => {
    mockEssay.mockResolvedValue(note({ id: 4, essay: 'A warm letter about bending.' }));
    const onEssayLoaded = jest.fn();
    const { findByTestId } = render(
      <ResonanceEssayModal note={note()} onClose={jest.fn()} onEssayLoaded={onEssayLoaded} />,
    );
    await askForTheLetter(findByTestId);
    const text = await findByTestId('essay-text');
    expect(text.props.children).toBe('A warm letter about bending.');
    expect(mockEssay).toHaveBeenCalledTimes(1);
    expect(mockEssay).toHaveBeenCalledWith(4, { priceAcknowledged: true });
    expect(onEssayLoaded).toHaveBeenCalledTimes(1);
  });

  it('renders a cached essay without calling the API', async () => {
    const { getByTestId } = render(
      <ResonanceEssayModal note={note({ essay: 'Already here.' })} onClose={jest.fn()} />,
    );
    await waitFor(() => expect(getByTestId('essay-text').props.children).toBe('Already here.'));
    expect(mockEssay).not.toHaveBeenCalled();
    expect(mockUsage).not.toHaveBeenCalled();
  });

  it('shows the kind and the anchored passage as a pulled quote', () => {
    const { getByTestId } = render(
      <ResonanceEssayModal
        note={note({ essay: 'x', anchor_text: 'the willow' })}
        onClose={jest.fn()}
      />,
    );
    expect(getByTestId('essay-quote').props.children.join('')).toContain('the willow');
  });

  it('dismisses via the scrim and the close control', () => {
    const onClose = jest.fn();
    const { getByTestId } = render(
      <ResonanceEssayModal note={note({ essay: 'x' })} onClose={onClose} />,
    );
    fireEvent.press(getByTestId('essay-scrim'));
    fireEvent.press(getByTestId('essay-close'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('treats a blank fetched essay as a failure, offering retry instead of an empty body', async () => {
    mockEssay.mockResolvedValue(note({ id: 4, essay: '' }));
    const onEssayLoaded = jest.fn();
    const { findByTestId, queryByTestId } = render(
      <ResonanceEssayModal note={note()} onClose={jest.fn()} onEssayLoaded={onEssayLoaded} />,
    );
    await askForTheLetter(findByTestId);
    await findByTestId('essay-retry');
    expect(queryByTestId('essay-text')).toBeNull();
    expect(onEssayLoaded).not.toHaveBeenCalled();
    expect(mockEssay).toHaveBeenCalledTimes(1);
  });

  /**
   * Pre-existing guard, previously unpinned: ``useEssay`` drops a letter that
   * resolves after the modal closed. The drop itself is harmless -- the route is
   * idempotent and the next open returns the cached essay -- but applying it
   * would call ``onEssayLoaded``, which is ``setOpenNote`` in JournalEntryScreen,
   * and would spring a journal surface back open that the writer had closed.
   * The assertion is therefore on the callback, not on an absence of rendering:
   * a modal that never mounted would satisfy the latter vacuously.
   */
  it('drops a letter that resolves after the modal closed instead of reopening it', async () => {
    let answer: (_n: Marginalia) => void = () => undefined;
    mockEssay.mockReturnValue(
      new Promise<Marginalia>((resolve) => {
        answer = resolve;
      }),
    );
    const onEssayLoaded = jest.fn();
    const { getByTestId, findByTestId, rerender } = render(
      <ResonanceEssayModal note={note()} onClose={jest.fn()} onEssayLoaded={onEssayLoaded} />,
    );
    await askForTheLetter(findByTestId);
    // The ask really is in flight against an open modal, so the drop below is
    // the guard working rather than nothing having happened.
    expect(mockEssay).toHaveBeenCalledTimes(1);
    expect(getByTestId('essay-loading')).toBeTruthy();

    rerender(<ResonanceEssayModal note={null} onClose={jest.fn()} onEssayLoaded={onEssayLoaded} />);
    await act(async () => {
      answer(note({ id: 4, essay: 'A letter that arrived too late.' }));
    });

    // Reopening the note is the parent's to do, and only it can: the first test
    // above proves this same resolution calls onEssayLoaded while still open.
    expect(onEssayLoaded).not.toHaveBeenCalled();
  });

  it('shows a friendly error; retry returns to the offer, and asking again refetches', async () => {
    mockEssay
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(note({ id: 4, essay: 'Recovered essay.' }));
    const { findByTestId } = render(
      <ResonanceEssayModal note={note()} onClose={jest.fn()} onEssayLoaded={jest.fn()} />,
    );
    await askForTheLetter(findByTestId);
    const retry = await findByTestId('essay-retry');
    await act(async () => {
      fireEvent.press(retry);
    });
    // Back at the price, never an automatic second ask.
    expect(mockEssay).toHaveBeenCalledTimes(1);
    await askForTheLetter(findByTestId);
    expect((await findByTestId('essay-text')).props.children).toBe('Recovered essay.');
    expect(mockEssay).toHaveBeenCalledTimes(2);
  });
});

/**
 * Reopening a note the server answered without a letter.
 *
 * The server deliberately leaves ``essay`` NULL when a completion is refused as
 * not-a-letter, so the writer can ask again. That contract is what made the
 * modal re-ask on *every* reopen (#2435). The guard below has to stop the
 * automatic ask without taking the deliberate one away.
 *
 * The copy asserted here is hand-written rather than imported: a test that
 * reads the same constant the screen renders proves only that a string equals
 * itself. Every assertion counts calls to ``resonance.essay`` explicitly, and
 * checks the reopened modal really is on screen showing the note — so a build
 * that simply never reopened it could not pass by issuing no request.
 */
describe('ResonanceEssayModal reopened after a letter that never arrived', () => {
  /** Hand-written copy of the blank-essay sentence the screen renders. */
  const BLANK_COPY = "This note's essay isn't ready yet.";
  /** A rejection whose message is passed through verbatim by ``formatApiError``. */
  const FAILURE_COPY = 'The provider never answered.';

  /** Close the modal, then open the same note again — a fresh object with the
   *  same id, which is what a refreshed marginalia list hands the screen. */
  async function reopen(
    rerender: (_ui: React.ReactElement) => void,
    reopened: Marginalia,
  ): Promise<void> {
    rerender(<ResonanceEssayModal note={null} onClose={jest.fn()} onEssayLoaded={jest.fn()} />);
    rerender(<ResonanceEssayModal note={reopened} onClose={jest.fn()} onEssayLoaded={jest.fn()} />);
    // Flush any effect-scheduled promise, so a re-ask would be counted below.
    await act(async () => {});
  }

  it('does not re-ask for a note whose letter came back blank, and still says so', async () => {
    mockEssay.mockResolvedValue(note({ id: 4, essay: '' }));
    const { findByTestId, getByTestId, getByText, queryByTestId, rerender } = render(
      <ResonanceEssayModal note={note()} onClose={jest.fn()} onEssayLoaded={jest.fn()} />,
    );
    await askForTheLetter(findByTestId);
    await findByTestId('essay-retry');

    await reopen(rerender, note({ id: 4 }));

    expect(mockEssay).toHaveBeenCalledTimes(1);
    // Not vacuous: the modal really is open on that note, showing the message
    // and the retry affordance rather than an empty card.
    expect(getByTestId('essay-quote').props.children.join('')).toContain('willow');
    expect(getByText(BLANK_COPY)).toBeTruthy();
    expect(getByTestId('essay-retry')).toBeTruthy();
    expect(queryByTestId('essay-text')).toBeNull();
    expect(queryByTestId('essay-loading')).toBeNull();
  });

  it('does not re-ask for a note whose request failed, and still shows the error', async () => {
    mockEssay.mockRejectedValue(new Error(FAILURE_COPY));
    const { findByTestId, getByTestId, getByText, queryByTestId, rerender } = render(
      <ResonanceEssayModal note={note()} onClose={jest.fn()} onEssayLoaded={jest.fn()} />,
    );
    await askForTheLetter(findByTestId);
    await findByTestId('essay-retry');

    await reopen(rerender, note({ id: 4 }));

    expect(mockEssay).toHaveBeenCalledTimes(1);
    expect(getByTestId('essay-quote').props.children.join('')).toContain('willow');
    expect(getByText(FAILURE_COPY)).toBeTruthy();
    expect(getByTestId('essay-retry')).toBeTruthy();
    expect(queryByTestId('essay-loading')).toBeNull();
  });

  it('still lets the writer ask again on purpose after a reopen', async () => {
    mockEssay
      .mockResolvedValueOnce(note({ id: 4, essay: '' }))
      .mockResolvedValueOnce(note({ id: 4, essay: 'The letter, on the second ask.' }));
    const { findByTestId, rerender } = render(
      <ResonanceEssayModal note={note()} onClose={jest.fn()} onEssayLoaded={jest.fn()} />,
    );
    await askForTheLetter(findByTestId);
    await findByTestId('essay-retry');

    await reopen(rerender, note({ id: 4 }));
    await act(async () => {
      fireEvent.press(await findByTestId('essay-retry'));
    });
    await askForTheLetter(findByTestId);

    expect(mockEssay).toHaveBeenCalledTimes(2);
    expect((await findByTestId('essay-text')).props.children).toBe(
      'The letter, on the second ask.',
    );
  });

  it('offers the letter for a different note that has never been opened', async () => {
    mockEssay
      .mockResolvedValueOnce(note({ id: 4, essay: '' }))
      .mockResolvedValueOnce(note({ id: 9, essay: 'A letter for the other note.' }));
    const { findByTestId, rerender } = render(
      <ResonanceEssayModal note={note()} onClose={jest.fn()} onEssayLoaded={jest.fn()} />,
    );
    await askForTheLetter(findByTestId);
    await findByTestId('essay-retry');

    await reopen(rerender, note({ id: 9, anchor_text: 'the river' }));
    expect(mockEssay).toHaveBeenCalledTimes(1);
    await askForTheLetter(findByTestId);

    expect(mockEssay).toHaveBeenCalledTimes(2);
    expect(mockEssay).toHaveBeenLastCalledWith(9, { priceAcknowledged: true });
    expect((await findByTestId('essay-text')).props.children).toBe('A letter for the other note.');
  });

  it('does not re-ask when the writer closed the modal while the ask was in flight', async () => {
    let answer: (_n: Marginalia) => void = () => undefined;
    mockEssay.mockReturnValue(
      new Promise<Marginalia>((resolve) => {
        answer = resolve;
      }),
    );
    const { findByTestId, getByTestId, getByText, queryByTestId, rerender } = render(
      <ResonanceEssayModal note={note()} onClose={jest.fn()} onEssayLoaded={jest.fn()} />,
    );
    await askForTheLetter(findByTestId);
    expect(getByTestId('essay-loading')).toBeTruthy();

    // The writer closes the modal before the answer arrives; the ask still
    // lands, and produces no letter.
    rerender(<ResonanceEssayModal note={null} onClose={jest.fn()} onEssayLoaded={jest.fn()} />);
    await act(async () => {
      answer(note({ id: 4, essay: '' }));
    });

    rerender(
      <ResonanceEssayModal note={note({ id: 4 })} onClose={jest.fn()} onEssayLoaded={jest.fn()} />,
    );
    await act(async () => {});

    expect(mockEssay).toHaveBeenCalledTimes(1);
    expect(getByText(BLANK_COPY)).toBeTruthy();
    expect(queryByTestId('essay-loading')).toBeNull();
  });

  it('offers a note carrying a blank cached essay instead of drawing an empty body', async () => {
    mockEssay.mockResolvedValue(note({ id: 4, essay: 'The letter that was missing.' }));
    const { findByTestId } = render(
      <ResonanceEssayModal
        note={note({ id: 4, essay: '' })}
        onClose={jest.fn()}
        onEssayLoaded={jest.fn()}
      />,
    );
    await askForTheLetter(findByTestId);

    expect((await findByTestId('essay-text')).props.children).toBe('The letter that was missing.');
    expect(mockEssay).toHaveBeenCalledTimes(1);
  });

  it('offers again on a fresh mount, because a refusal is transient', async () => {
    mockEssay.mockResolvedValue(note({ id: 4, essay: '' }));
    const first = render(
      <ResonanceEssayModal note={note()} onClose={jest.fn()} onEssayLoaded={jest.fn()} />,
    );
    await askForTheLetter(first.findByTestId);
    await first.findByTestId('essay-retry');
    first.unmount();

    const second = render(
      <ResonanceEssayModal note={note()} onClose={jest.fn()} onEssayLoaded={jest.fn()} />,
    );
    await askForTheLetter(second.findByTestId);
    await second.findByTestId('essay-retry');

    // The memory dies with the screen: leaving the journal and coming back is
    // the writer asking again, which the server's do-not-cache contract allows.
    expect(mockEssay).toHaveBeenCalledTimes(2);
  });
});

/**
 * A note's first letter is a charged depth (#623), so it is offered with its
 * price on it and only an explicit ask spends. Copy is hand-written here, not
 * imported, for the reason given above.
 */
describe('ResonanceEssayModal offers a first letter at its price', () => {
  it('opens a cached letter from a mounted-but-closed modal with no offer and no wallet read', async () => {
    const { getByTestId, queryByTestId, rerender } = render(
      <ResonanceEssayModal note={null} onClose={jest.fn()} />,
    );
    rerender(<ResonanceEssayModal note={note({ essay: 'Kept.' })} onClose={jest.fn()} />);
    expect(queryByTestId('essay-offer')).toBeNull();
    await act(async () => {});
    expect(getByTestId('essay-text').props.children).toBe('Kept.');
    expect(mockUsage).not.toHaveBeenCalled();
    expect(mockEssay).not.toHaveBeenCalled();
  });

  it('does not call resonance.essay on open', async () => {
    const { findByTestId } = render(
      <ResonanceEssayModal note={note()} onClose={jest.fn()} onEssayLoaded={jest.fn()} />,
    );
    await findByTestId('essay-offer');
    await act(async () => {});
    expect(mockEssay).not.toHaveBeenCalled();
  });

  it('names the monthly allowance when the wallet pays', async () => {
    mockUsage.mockResolvedValue(usage(20, 12));
    const { findByTestId } = render(<ResonanceEssayModal note={note()} onClose={jest.fn()} />);
    await waitFor(async () =>
      expect((await findByTestId('essay-ask-cost')).props.children).toBe(
        'This letter spends one of your 20 BotMason messages for the month. Add your own API key in Settings to bill that key instead.',
      ),
    );
  });

  it('names an offering once the month is spent', async () => {
    mockUsage.mockResolvedValue(usage(20, 0, 3));
    const { findByTestId } = render(<ResonanceEssayModal note={note()} onClose={jest.fn()} />);
    await waitFor(async () =>
      expect((await findByTestId('essay-ask-cost')).props.children).toBe(
        'This letter spends one BotMason offering. Add your own API key in Settings to bill that key instead.',
      ),
    );
  });

  it('says the writer’s own key pays, without reading the wallet', async () => {
    const { findByTestId } = render(
      <ResonanceEssayModal note={note()} onClose={jest.fn()} hasOwnKey />,
    );
    await waitFor(async () =>
      expect((await findByTestId('essay-ask-cost')).props.children).toBe(
        'Your own API key pays for this letter. Nothing is drawn from your BotMason messages.',
      ),
    );
    expect(mockUsage).not.toHaveBeenCalled();
  });

  it('closes on "Not now" without asking', async () => {
    const onClose = jest.fn();
    const { findByTestId } = render(<ResonanceEssayModal note={note()} onClose={onClose} />);
    await act(async () => {
      fireEvent.press(await findByTestId('essay-not-now'));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockEssay).not.toHaveBeenCalled();
  });

  it('gives both arms a button role and a spoken label', async () => {
    const { findByTestId } = render(<ResonanceEssayModal note={note()} onClose={jest.fn()} />);
    const ask = await findByTestId('essay-ask');
    const notNow = await findByTestId('essay-not-now');
    expect(ask.props.accessibilityRole).toBe('button');
    expect(ask.props.accessibilityLabel).toBe('Ask for the letter for this note');
    expect(notNow.props.accessibilityRole).toBe('button');
    expect(notNow.props.accessibilityLabel).toBe('Not now — do not write this letter');
  });

  it.each([
    ['insufficient_offerings', 'funding_required'],
    ['llm_key_required', 'key_required'],
  ])(
    'hands a 402 %s to onFundingRequired instead of rendering an error',
    async (detail, outcome) => {
      mockEssay.mockRejectedValue(new ApiError(402, detail));
      const onFundingRequired = jest.fn();
      const { findByTestId, queryByTestId } = render(
        <ResonanceEssayModal
          note={note()}
          onClose={jest.fn()}
          onFundingRequired={onFundingRequired}
        />,
      );
      await askForTheLetter(findByTestId);

      expect(onFundingRequired).toHaveBeenCalledWith(outcome);
      expect(queryByTestId('essay-retry')).toBeNull();
      expect(await findByTestId('essay-offer')).toBeTruthy();
    },
  );
});
