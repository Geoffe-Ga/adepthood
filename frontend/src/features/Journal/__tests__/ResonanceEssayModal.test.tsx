/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import type { Marginalia } from '@/api';

const mockEssay = jest.fn() as jest.MockedFunction<(_id: number) => Promise<Marginalia>>;

jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api') as Record<string, unknown>;
  return {
    ...actual,
    resonance: {
      essay: (...a: unknown[]) => (mockEssay as unknown as (...x: unknown[]) => unknown)(...a),
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

beforeEach(() => {
  mockEssay.mockReset();
});

describe('ResonanceEssayModal', () => {
  it('lazily fetches the essay once when the note has none, then renders it', async () => {
    mockEssay.mockResolvedValue(note({ id: 4, essay: 'A warm letter about bending.' }));
    const onEssayLoaded = jest.fn();
    const { findByTestId } = render(
      <ResonanceEssayModal note={note()} onClose={jest.fn()} onEssayLoaded={onEssayLoaded} />,
    );
    const text = await findByTestId('essay-text');
    expect(text.props.children).toBe('A warm letter about bending.');
    expect(mockEssay).toHaveBeenCalledTimes(1);
    expect(onEssayLoaded).toHaveBeenCalledTimes(1);
  });

  it('renders a cached essay without calling the API', async () => {
    const { getByTestId } = render(
      <ResonanceEssayModal note={note({ essay: 'Already here.' })} onClose={jest.fn()} />,
    );
    await waitFor(() => expect(getByTestId('essay-text').props.children).toBe('Already here.'));
    expect(mockEssay).not.toHaveBeenCalled();
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
    const { getByTestId, rerender } = render(
      <ResonanceEssayModal note={note()} onClose={jest.fn()} onEssayLoaded={onEssayLoaded} />,
    );
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

  it('shows a friendly error with retry, and retry refetches', async () => {
    mockEssay
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(note({ id: 4, essay: 'Recovered essay.' }));
    const { findByTestId } = render(
      <ResonanceEssayModal note={note()} onClose={jest.fn()} onEssayLoaded={jest.fn()} />,
    );
    const retry = await findByTestId('essay-retry');
    await act(async () => {
      fireEvent.press(retry);
    });
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
    await findByTestId('essay-retry');

    await reopen(rerender, note({ id: 4 }));
    await act(async () => {
      fireEvent.press(await findByTestId('essay-retry'));
    });

    expect(mockEssay).toHaveBeenCalledTimes(2);
    expect((await findByTestId('essay-text')).props.children).toBe(
      'The letter, on the second ask.',
    );
  });

  it('still asks for a different note that has never been opened', async () => {
    mockEssay
      .mockResolvedValueOnce(note({ id: 4, essay: '' }))
      .mockResolvedValueOnce(note({ id: 9, essay: 'A letter for the other note.' }));
    const { findByTestId, rerender } = render(
      <ResonanceEssayModal note={note()} onClose={jest.fn()} onEssayLoaded={jest.fn()} />,
    );
    await findByTestId('essay-retry');

    await reopen(rerender, note({ id: 9, anchor_text: 'the river' }));

    expect(mockEssay).toHaveBeenCalledTimes(2);
    expect(mockEssay).toHaveBeenLastCalledWith(9);
    expect((await findByTestId('essay-text')).props.children).toBe('A letter for the other note.');
  });

  it('does not re-ask when the writer closed the modal while the ask was in flight', async () => {
    let answer: (_n: Marginalia) => void = () => undefined;
    mockEssay.mockReturnValue(
      new Promise<Marginalia>((resolve) => {
        answer = resolve;
      }),
    );
    const { getByTestId, getByText, queryByTestId, rerender } = render(
      <ResonanceEssayModal note={note()} onClose={jest.fn()} onEssayLoaded={jest.fn()} />,
    );
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

  it('asks for a note carrying a blank cached essay instead of drawing an empty body', async () => {
    mockEssay.mockResolvedValue(note({ id: 4, essay: 'The letter that was missing.' }));
    const { findByTestId } = render(
      <ResonanceEssayModal
        note={note({ id: 4, essay: '' })}
        onClose={jest.fn()}
        onEssayLoaded={jest.fn()}
      />,
    );

    expect((await findByTestId('essay-text')).props.children).toBe('The letter that was missing.');
    expect(mockEssay).toHaveBeenCalledTimes(1);
  });

  it('asks again on a fresh mount, because a refusal is transient', async () => {
    mockEssay.mockResolvedValue(note({ id: 4, essay: '' }));
    const first = render(
      <ResonanceEssayModal note={note()} onClose={jest.fn()} onEssayLoaded={jest.fn()} />,
    );
    await first.findByTestId('essay-retry');
    first.unmount();

    const second = render(
      <ResonanceEssayModal note={note()} onClose={jest.fn()} onEssayLoaded={jest.fn()} />,
    );
    await second.findByTestId('essay-retry');

    // The memory dies with the screen: leaving the journal and coming back is
    // the writer asking again, which the server's do-not-cache contract allows.
    expect(mockEssay).toHaveBeenCalledTimes(2);
  });
});
