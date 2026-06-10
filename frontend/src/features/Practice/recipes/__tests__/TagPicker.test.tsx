import { describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import TagPicker from '../TagPicker';

import type { PracticeTag } from '@/api';

const library: PracticeTag[] = [
  { id: 1, slug: 'red', label: 'Red', owner_user_id: null, created_at: '2026-01-01T00:00:00Z' },
  { id: 2, slug: 'blue', label: 'Blue', owner_user_id: null, created_at: '2026-01-01T00:00:00Z' },
];

function renderPicker(
  overrides: Partial<React.ComponentProps<typeof TagPicker>> = {},
): ReturnType<typeof render> {
  return render(
    <TagPicker
      stepIndex={0}
      selectedSlug=""
      tagLibrary={library}
      onSelect={jest.fn()}
      onCreateTag={jest.fn(async () => undefined)}
      {...overrides}
    />,
  );
}

describe('TagPicker', () => {
  it('shows the selected tag on the collapsed trigger', () => {
    const utils = renderPicker({ selectedSlug: 'red' });
    expect(utils.getByTestId('tag-picker-0-trigger')).toBeTruthy();
    expect(utils.getByText('Red')).toBeTruthy();
    // Badge reflects ownership of the chosen tag.
    expect(utils.getByTestId('tag-picker-0-badge')).toHaveTextContent('System');
  });

  it('opens to a searchable list of library tags', () => {
    const utils = renderPicker();
    expect(utils.queryByTestId('tag-picker-0-panel')).toBeNull();
    fireEvent.press(utils.getByTestId('tag-picker-0-trigger'));
    expect(utils.getByTestId('tag-picker-0-option-red')).toBeTruthy();
    expect(utils.getByTestId('tag-picker-0-option-blue')).toBeTruthy();
  });

  it('filters the list by search query', () => {
    const utils = renderPicker();
    fireEvent.press(utils.getByTestId('tag-picker-0-trigger'));
    fireEvent.changeText(utils.getByTestId('tag-picker-0-search'), 'blue');
    expect(utils.getByTestId('tag-picker-0-option-blue')).toBeTruthy();
    expect(utils.queryByTestId('tag-picker-0-option-red')).toBeNull();
  });

  it('marks the active selection on its option row', () => {
    const utils = renderPicker({ selectedSlug: 'red' });
    fireEvent.press(utils.getByTestId('tag-picker-0-trigger'));
    expect(utils.getByTestId('tag-picker-0-option-red').props.accessibilityState.selected).toBe(
      true,
    );
  });

  it('selects a tag when its row is pressed', () => {
    const onSelect = jest.fn();
    const utils = renderPicker({ onSelect });
    fireEvent.press(utils.getByTestId('tag-picker-0-trigger'));
    fireEvent.press(utils.getByTestId('tag-picker-0-option-blue'));
    expect(onSelect).toHaveBeenCalledWith(library[1]);
  });

  it('shows the inline creator and submits a new tag, seeded from the query', async () => {
    const onCreateTag = jest.fn(async (_payload: { slug: string; label: string }) => undefined);
    const utils = renderPicker({ onCreateTag });
    fireEvent.press(utils.getByTestId('tag-picker-0-trigger'));
    fireEvent.changeText(utils.getByTestId('tag-picker-0-search'), 'Crimson Star');
    fireEvent.press(utils.getByTestId('tag-picker-0-new'));
    expect(utils.getByTestId('tag-picker-0-creator')).toBeTruthy();
    // Label is pre-filled from the search query.
    expect(utils.getByTestId('tag-picker-0-creator-label').props.value).toBe('Crimson Star');
    await act(async () => {
      fireEvent.press(utils.getByTestId('tag-picker-0-creator-confirm'));
    });
    await waitFor(() => expect(onCreateTag).toHaveBeenCalled());
    const firstCall = onCreateTag.mock.calls[0];
    if (firstCall === undefined) throw new Error('onCreateTag was not called');
    const callArgs = firstCall[0] as { slug: string; label: string };
    expect(callArgs.slug).toBe('crimson_star');
    expect(callArgs.label).toBe('Crimson Star');
  });

  it('cancels the inline creator', () => {
    const utils = renderPicker();
    fireEvent.press(utils.getByTestId('tag-picker-0-trigger'));
    fireEvent.press(utils.getByTestId('tag-picker-0-new'));
    fireEvent.press(utils.getByTestId('tag-picker-0-creator-cancel'));
    expect(utils.queryByTestId('tag-picker-0-creator')).toBeNull();
  });

  it('groups personal tags under "Yours" and badges them Custom', () => {
    const mixed: PracticeTag[] = [
      ...library,
      { id: 9, slug: 'mine', label: 'Mine', owner_user_id: 7, created_at: '2026-01-01T00:00:00Z' },
    ];
    const utils = renderPicker({ tagLibrary: mixed, selectedSlug: 'mine' });
    expect(utils.getByTestId('tag-picker-0-badge')).toHaveTextContent('Custom');
    fireEvent.press(utils.getByTestId('tag-picker-0-trigger'));
    expect(utils.getByTestId('tag-picker-0-group-library')).toBeTruthy();
    expect(utils.getByTestId('tag-picker-0-group-yours')).toBeTruthy();
    expect(utils.getByTestId('tag-picker-0-option-mine')).toBeTruthy();
  });

  it('filters by slug and shows the empty state when nothing matches', () => {
    const utils = renderPicker();
    fireEvent.press(utils.getByTestId('tag-picker-0-trigger'));
    fireEvent.changeText(utils.getByTestId('tag-picker-0-search'), 'blu'); // matches slug "blue"
    expect(utils.getByTestId('tag-picker-0-option-blue')).toBeTruthy();
    fireEvent.changeText(utils.getByTestId('tag-picker-0-search'), 'zzz');
    expect(utils.getByTestId('tag-picker-0-empty')).toBeTruthy();
  });

  it('falls back to the raw slug when the selection is not in the library', () => {
    const utils = renderPicker({ selectedSlug: 'ghost' });
    expect(utils.getByText('ghost')).toBeTruthy();
    // No badge when the tag is unknown to the library.
    expect(utils.queryByTestId('tag-picker-0-badge')).toBeNull();
  });

  it('surfaces a create error without dismissing the form', async () => {
    const onCreateTag = jest.fn(async () => {
      throw new Error('Slug already exists');
    });
    const utils = renderPicker({ onCreateTag });
    fireEvent.press(utils.getByTestId('tag-picker-0-trigger'));
    fireEvent.press(utils.getByTestId('tag-picker-0-new'));
    fireEvent.changeText(utils.getByTestId('tag-picker-0-creator-label'), 'Dupe');
    await act(async () => {
      fireEvent.press(utils.getByTestId('tag-picker-0-creator-confirm'));
    });
    await waitFor(() =>
      expect(utils.getByTestId('tag-picker-0-creator-error')).toHaveTextContent(
        'Slug already exists',
      ),
    );
  });
});
