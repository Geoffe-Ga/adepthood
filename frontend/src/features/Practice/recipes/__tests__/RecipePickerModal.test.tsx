import { describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import React from 'react';

import RecipePickerModal from '../RecipePickerModal';

import { practiceTags } from '@/api';
import type { PracticeRecipe, UserPractice } from '@/api';

// RecipePickerModal mounts its nested RecipeEditorModal without injecting
// listTags/create/update seams, so opening it falls through to the real
// `@/api` bindings. Stub `practiceTags.list` so that fallthrough never
// makes a real network call in tests; everything else stays real.
jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api') as Record<string, unknown>;
  return {
    ...actual,
    practiceTags: {
      list: jest.fn(async () => []),
      create: jest.fn(),
    },
  };
});

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
    expect(within(utils.getByTestId('recipe-row-1')).getByText('System')).toBeTruthy();
    expect(within(utils.getByTestId('recipe-row-2')).queryByText('System')).toBeNull();
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

  it('surfaces an apply failure inline and leaves the picker open', async () => {
    const apply = jest.fn(async (_recipeId: number, _upId: number) => {
      throw new Error('apply failed');
    });
    const utils = mountPicker({ apply: apply as never });
    await waitFor(() => expect(utils.getByTestId('recipe-row-1')).toBeTruthy());
    await act(async () => {
      fireEvent.press(utils.getByTestId('recipe-row-1-apply'));
    });
    await waitFor(() => expect(utils.getByTestId('recipe-picker-api-error')).toBeTruthy());
    expect(utils.onApplied).not.toHaveBeenCalled();
    expect(utils.onClose).not.toHaveBeenCalled();
  });

  it('surfaces a delete failure inline and does not refresh the list', async () => {
    const remove = jest.fn(async (_recipeId: number) => {
      throw new Error('delete failed');
    });
    const utils = mountPicker({ remove: remove as never });
    await waitFor(() => expect(utils.getByTestId('recipe-row-2')).toBeTruthy());
    await act(async () => {
      fireEvent.press(utils.getByTestId('recipe-row-2-delete'));
    });
    await waitFor(() => expect(utils.getByTestId('recipe-picker-api-error')).toBeTruthy());
    expect(utils.list).toHaveBeenCalledTimes(1);
  });

  it('opens the editor in create mode from the header + New button', async () => {
    const utils = mountPicker();
    await waitFor(() => expect(utils.getByTestId('recipe-row-1')).toBeTruthy());
    fireEvent.press(utils.getByTestId('recipe-picker-new'));
    expect(await utils.findByTestId('recipe-editor-sheet')).toBeTruthy();
    expect(utils.getByText('New recipe')).toBeTruthy();
    await waitFor(() => expect(practiceTags.list).toHaveBeenCalled());
  });

  it('opens the editor in edit mode for a personal recipe', async () => {
    const utils = mountPicker();
    await waitFor(() => expect(utils.getByTestId('recipe-row-2')).toBeTruthy());
    fireEvent.press(utils.getByTestId('recipe-row-2-edit'));
    expect(await utils.findByText('Edit recipe')).toBeTruthy();
    expect(utils.getByTestId('recipe-editor-name').props.value).toBe('My Custom');
    await waitFor(() => expect(practiceTags.list).toHaveBeenCalled());
  });

  it('forks a system recipe into a new draft named "<name> copy"', async () => {
    const utils = mountPicker();
    await waitFor(() => expect(utils.getByTestId('recipe-row-1')).toBeTruthy());
    fireEvent.press(utils.getByTestId('recipe-row-1-fork'));
    expect(await utils.findByText('New recipe')).toBeTruthy();
    expect(utils.getByTestId('recipe-editor-name').props.value).toBe('5-4-3-2-1 Grounding copy');
    await waitFor(() => expect(practiceTags.list).toHaveBeenCalled());
  });

  it('closing the forked editor returns to the closed state without a refresh', async () => {
    const utils = mountPicker();
    await waitFor(() => expect(utils.getByTestId('recipe-row-1')).toBeTruthy());
    fireEvent.press(utils.getByTestId('recipe-row-1-fork'));
    await waitFor(() => expect(practiceTags.list).toHaveBeenCalled());
    fireEvent.press(utils.getByTestId('recipe-editor-cancel'));
    expect(utils.queryByTestId('recipe-editor-sheet')).toBeNull();
    expect(utils.list).toHaveBeenCalledTimes(1);
  });
});
