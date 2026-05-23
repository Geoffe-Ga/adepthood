import { describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import TagPicker from '../TagPicker';

import type { PracticeTag } from '@/api';

const library: PracticeTag[] = [
  { id: 1, slug: 'red', label: 'Red', owner_user_id: null, created_at: '2026-01-01T00:00:00Z' },
  { id: 2, slug: 'blue', label: 'Blue', owner_user_id: null, created_at: '2026-01-01T00:00:00Z' },
];

describe('TagPicker', () => {
  it('renders one chip per tag in the library', () => {
    const utils = render(
      <TagPicker
        stepIndex={0}
        selectedSlug=""
        tagLibrary={library}
        onSelect={jest.fn()}
        onCreateTag={jest.fn(async () => undefined)}
      />,
    );
    expect(utils.getByTestId('tag-picker-0-chip-red')).toBeTruthy();
    expect(utils.getByTestId('tag-picker-0-chip-blue')).toBeTruthy();
  });

  it('reflects active selection on the chosen chip', () => {
    const utils = render(
      <TagPicker
        stepIndex={0}
        selectedSlug="red"
        tagLibrary={library}
        onSelect={jest.fn()}
        onCreateTag={jest.fn(async () => undefined)}
      />,
    );
    expect(utils.getByTestId('tag-picker-0-chip-red').props.accessibilityState.selected).toBe(true);
  });

  it('selects a tag when its chip is pressed', () => {
    const onSelect = jest.fn();
    const utils = render(
      <TagPicker
        stepIndex={0}
        selectedSlug=""
        tagLibrary={library}
        onSelect={onSelect}
        onCreateTag={jest.fn(async () => undefined)}
      />,
    );
    fireEvent.press(utils.getByTestId('tag-picker-0-chip-blue'));
    expect(onSelect).toHaveBeenCalledWith(library[1]);
  });

  it('shows the inline creator and submits a new tag', async () => {
    const onCreateTag = jest.fn(async (_payload: { slug: string; label: string }) => undefined);
    const utils = render(
      <TagPicker
        stepIndex={0}
        selectedSlug=""
        tagLibrary={library}
        onSelect={jest.fn()}
        onCreateTag={onCreateTag}
      />,
    );
    fireEvent.press(utils.getByTestId('tag-picker-0-new'));
    expect(utils.getByTestId('tag-picker-0-creator')).toBeTruthy();
    fireEvent.changeText(utils.getByTestId('tag-picker-0-creator-label'), 'Crimson Star');
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
    const utils = render(
      <TagPicker
        stepIndex={0}
        selectedSlug=""
        tagLibrary={library}
        onSelect={jest.fn()}
        onCreateTag={jest.fn(async () => undefined)}
      />,
    );
    fireEvent.press(utils.getByTestId('tag-picker-0-new'));
    fireEvent.press(utils.getByTestId('tag-picker-0-creator-cancel'));
    expect(utils.queryByTestId('tag-picker-0-creator')).toBeNull();
  });
});
