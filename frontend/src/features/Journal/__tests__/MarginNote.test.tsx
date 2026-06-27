/* eslint-env jest */
import { jest, describe, it, expect } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import MarginNote from '../MarginNote';

import type { Marginalia } from '@/api';

function note(overrides: Partial<Marginalia> = {}): Marginalia {
  return {
    id: 3,
    journal_entry_id: 1,
    kind: 'symbol',
    anchor_start: 0,
    anchor_end: 4,
    anchor_text: 'walk',
    note: 'The willow bends without breaking.',
    essay: null,
    essay_generated_at: null,
    status: 'active',
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

describe('MarginNote', () => {
  it('shows the kind label and the note text', () => {
    const { getByText } = render(<MarginNote note={note()} onOpen={jest.fn()} />);
    expect(getByText('symbol')).toBeTruthy();
    expect(getByText('The willow bends without breaking.')).toBeTruthy();
  });

  it('fires onOpen with the note when pressed', () => {
    const onOpen = jest.fn();
    const n = note({ id: 11 });
    const { getByTestId } = render(<MarginNote note={n} onOpen={onOpen} />);
    fireEvent.press(getByTestId('margin-note-11'));
    expect(onOpen).toHaveBeenCalledWith(n);
  });

  it('renders the dimmed stale variant', () => {
    const { getByTestId, getByText } = render(
      <MarginNote note={note({ id: 12, status: 'stale' })} onOpen={jest.fn()} />,
    );
    const card = getByTestId('margin-note-12');
    const flattened = Array.isArray(card.props.style)
      ? Object.assign({}, ...card.props.style)
      : card.props.style;
    expect(flattened.opacity).toBeLessThan(1);
    expect(getByText(/Anchor moved/)).toBeTruthy();
  });
});
