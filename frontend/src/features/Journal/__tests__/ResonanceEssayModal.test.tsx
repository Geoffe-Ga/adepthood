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
