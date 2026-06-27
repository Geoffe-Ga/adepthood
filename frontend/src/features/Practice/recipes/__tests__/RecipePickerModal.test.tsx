import { describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import RecipePickerModal from '../RecipePickerModal';

import type { PracticeRecipe, UserPractice } from '@/api';

const systemRecipe: PracticeRecipe = {
  id: 1,
  slug: 'five_four_three_two_one',
  name: '5-4-3-2-1 Grounding',
  description: 'Walk the five senses.',
  owner_user_id: null,
  mode: 'sense_grounding',
  rounds: 1,
  created_at: '2026-05-23T00:00:00Z',
  steps: [
    {
      position: 0,
      tag_slug: 'sight',
      tag_label: 'Sight',
      prompt_label: 'Name 5 things you can see',
      target_count: 5,
    },
  ],
};

const userRecipe: PracticeRecipe = {
  id: 2,
  slug: 'my_custom',
  name: 'My Custom',
  description: '',
  owner_user_id: 99,
  mode: 'sense_grounding',
  rounds: 1,
  created_at: '2026-05-23T00:00:00Z',
  steps: [
    {
      position: 0,
      tag_slug: 'sight',
      tag_label: 'Sight',
      prompt_label: 'My prompt',
      target_count: 1,
    },
  ],
};

const userPracticeFixture: UserPractice = {
  id: 17,
  user_id: 1,
  practice_id: 5,
  stage_number: 1,
  start_date: '2026-05-01',
  end_date: null,
  effective_name: 'Updated',
};

function mountPicker(overrides: Partial<React.ComponentProps<typeof RecipePickerModal>> = {}) {
  const list = jest.fn(async (_mode?: string) => [systemRecipe, userRecipe]);
  const apply = jest.fn(async (_recipeId: number, _upId: number) => userPracticeFixture);
  const remove = jest.fn(async (_recipeId: number) => undefined);
  const onClose = jest.fn();
  const onApplied = jest.fn();
  const utils = render(
    <RecipePickerModal
      visible
      mode="sense_grounding"
      userPracticeId={17}
      onClose={onClose}
      onApplied={onApplied}
      list={list as never}
      apply={apply as never}
      remove={remove as never}
      {...overrides}
    />,
  );
  return { ...utils, list, apply, remove, onClose, onApplied };
}

describe('RecipePickerModal', () => {
  it('loads and renders system + user recipes', async () => {
    const utils = mountPicker();
    await waitFor(() => expect(utils.list).toHaveBeenCalledWith('sense_grounding'));
    await waitFor(() => expect(utils.getByTestId('recipe-row-1')).toBeTruthy());
    expect(utils.getByTestId('recipe-row-2')).toBeTruthy();
  });

  it('shows a System badge on read-only recipes', async () => {
    const utils = mountPicker();
    await waitFor(() => expect(utils.getByTestId('recipe-row-1')).toBeTruthy());
    expect(utils.queryByText('System')).toBeTruthy();
  });

  it('renders "Edit a copy" on system rows and "Edit" on user rows', async () => {
    const utils = mountPicker();
    await waitFor(() => expect(utils.getByTestId('recipe-row-1')).toBeTruthy());
    expect(utils.getByTestId('recipe-row-1-fork')).toBeTruthy();
    expect(utils.queryByTestId('recipe-row-1-edit')).toBeNull();
    expect(utils.getByTestId('recipe-row-2-edit')).toBeTruthy();
    expect(utils.queryByTestId('recipe-row-2-fork')).toBeNull();
  });

  it('keeps an accessible role + label on the primary and secondary row actions', async () => {
    const utils = mountPicker();
    await waitFor(() => expect(utils.getByTestId('recipe-row-2')).toBeTruthy());
    for (const [testID, label] of [
      ['recipe-row-2-apply', 'Use this'],
      ['recipe-row-2-edit', 'Edit'],
      ['recipe-row-2-delete', 'Delete'],
      ['recipe-row-1-fork', 'Edit a copy'],
    ] as const) {
      const node = utils.getByTestId(testID);
      expect(node.props.accessibilityRole).toBe('button');
      expect(node.props.accessibilityLabel).toBe(label);
    }
  });

  it('applies a recipe and closes the picker', async () => {
    const utils = mountPicker();
    await waitFor(() => expect(utils.getByTestId('recipe-row-1')).toBeTruthy());
    await act(async () => {
      fireEvent.press(utils.getByTestId('recipe-row-1-apply'));
    });
    await waitFor(() => expect(utils.apply).toHaveBeenCalledWith(1, 17));
    expect(utils.onApplied).toHaveBeenCalledWith(userPracticeFixture);
    expect(utils.onClose).toHaveBeenCalled();
  });

  it('deletes a personal recipe and refreshes the list', async () => {
    const utils = mountPicker();
    await waitFor(() => expect(utils.getByTestId('recipe-row-2')).toBeTruthy());
    await act(async () => {
      fireEvent.press(utils.getByTestId('recipe-row-2-delete'));
    });
    await waitFor(() => expect(utils.remove).toHaveBeenCalledWith(2));
    // initial load + refresh after delete
    await waitFor(() => expect(utils.list).toHaveBeenCalledTimes(2));
  });

  it('surfaces a load error in the empty state', async () => {
    const list = jest.fn(async () => {
      throw new Error('network down');
    });
    const utils = mountPicker({ list: list as never });
    await waitFor(() => expect(utils.getByTestId('recipe-picker-list-error')).toBeTruthy());
  });

  it('renders an empty-state message when there are no recipes', async () => {
    const list = jest.fn(async () => []);
    const utils = mountPicker({ list: list as never });
    await waitFor(() => expect(utils.getByTestId('recipe-picker-empty')).toBeTruthy());
  });
});
