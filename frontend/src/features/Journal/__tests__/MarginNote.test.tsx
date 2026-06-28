/* eslint-env jest */
import { jest, describe, it, expect } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import MarginNote from '../MarginNote';

import type { Marginalia } from '@/api';
import { colors } from '@/design/tokens';

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
    expect(getByText(/The passage this noted has changed/)).toBeTruthy();
  });

  it('lifts the card off the page and colour-codes the left bar by kind', () => {
    for (const kind of ['theme', 'connection'] as const) {
      const { getByTestId } = render(
        <MarginNote note={note({ id: 20, kind })} onOpen={jest.fn()} />,
      );
      const card = StyleSheet.flatten(getByTestId('margin-note-20').props.style);
      // Lifted by the warm paper card shadow (iOS/web shadow + Android elevation).
      expect(card.shadowRadius).toBeGreaterThan(0);
      expect(card.elevation).toBeGreaterThan(0);
      // The left bar carries the note's kind accent.
      expect(card.borderLeftColor).toBe(colors.marginalia[kind]);
    }
  });

  it('a stale note is still openable', () => {
    const onOpen = jest.fn();
    const n = note({ id: 13, status: 'stale' });
    const { getByTestId } = render(<MarginNote note={n} onOpen={onOpen} />);
    fireEvent.press(getByTestId('margin-note-13'));
    expect(onOpen).toHaveBeenCalledWith(n);
  });
});
