import { describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import RecipeEditorModal from '../RecipeEditorModal';
import type { RecipeDraft } from '../types';
import { newStepUid } from '../types';

import type { PracticeRecipe, PracticeTag } from '@/api';

function makeDraft(overrides: Partial<RecipeDraft> = {}): RecipeDraft {
  return {
    slug: '',
    name: '',
    description: '',
    mode: 'tallied_grounding',
    rounds: 1,
    steps: [
      {
        uid: newStepUid(),
        tag_slug: '',
        tag_label: '',
        prompt_label: '',
        target_count: 1,
      },
    ],
    ...overrides,
  };
}

const tagLibrary: PracticeTag[] = [
  { id: 1, slug: 'red', label: 'Red', owner_user_id: null, created_at: '2026-01-01T00:00:00Z' },
  { id: 2, slug: 'blue', label: 'Blue', owner_user_id: null, created_at: '2026-01-01T00:00:00Z' },
];

const savedFixture: PracticeRecipe = {
  id: 42,
  slug: 'new_one',
  name: 'New one',
  description: '',
  owner_user_id: 7,
  mode: 'tallied_grounding',
  rounds: 1,
  created_at: '2026-05-23T00:00:00Z',
  steps: [],
};

function mountEditor(overrides: Partial<React.ComponentProps<typeof RecipeEditorModal>> = {}) {
  const create = jest.fn(async (_payload: unknown) => savedFixture);
  const update = jest.fn(async (_recipeId: number, _payload: unknown) => savedFixture);
  const listTags = jest.fn(async () => tagLibrary);
  const createTag = jest.fn(async (payload: { slug: string; label: string }) => ({
    id: 99,
    slug: payload.slug,
    label: payload.label,
    owner_user_id: 7,
    created_at: '2026-05-23T00:00:00Z',
  }));
  const onClose = jest.fn();
  const onSaved = jest.fn();
  const draft = makeDraft({
    name: 'My Recipe',
    steps: [
      {
        uid: newStepUid(),
        tag_slug: 'red',
        tag_label: 'Red',
        prompt_label: 'Find red',
        target_count: 1,
      },
    ],
  });
  const utils = render(
    <RecipeEditorModal
      visible
      mode="tallied_grounding"
      initialDraft={draft}
      recipeId={null}
      onClose={onClose}
      onSaved={onSaved}
      create={create as never}
      update={update as never}
      listTags={listTags as never}
      createTag={createTag as never}
      {...overrides}
    />,
  );
  return { ...utils, create, update, listTags, createTag, onClose, onSaved };
}

describe('RecipeEditorModal', () => {
  it('renders with the initial draft populated', async () => {
    const utils = mountEditor();
    await waitFor(() => expect(utils.listTags).toHaveBeenCalled());
    expect(utils.getByTestId('recipe-editor-name').props.value).toBe('My Recipe');
    expect(utils.getByTestId('recipe-editor-step-0')).toBeTruthy();
  });

  it('blocks save until name + tag are set', () => {
    const utils = mountEditor({ initialDraft: makeDraft() });
    const save = utils.getByTestId('recipe-editor-save');
    expect(save.props.accessibilityState.disabled).toBe(true);
  });

  it('calls create with the assembled payload', async () => {
    const utils = mountEditor();
    await waitFor(() => expect(utils.listTags).toHaveBeenCalled());
    await act(async () => {
      fireEvent.press(utils.getByTestId('recipe-editor-save'));
    });
    await waitFor(() => expect(utils.create).toHaveBeenCalled());
    const firstCall = utils.create.mock.calls[0];
    if (firstCall === undefined) throw new Error('create was not called');
    const callArgs = firstCall[0] as Record<string, unknown>;
    expect(callArgs.name).toBe('My Recipe');
    expect(callArgs.mode).toBe('tallied_grounding');
    expect(callArgs.slug).toBe('my_recipe');
    expect(Array.isArray(callArgs.steps)).toBe(true);
    expect(utils.onSaved).toHaveBeenCalledWith(savedFixture);
  });

  it('calls update when editing an existing recipe', async () => {
    const utils = mountEditor({ recipeId: 17 });
    await waitFor(() => expect(utils.listTags).toHaveBeenCalled());
    await act(async () => {
      fireEvent.press(utils.getByTestId('recipe-editor-save'));
    });
    await waitFor(() => expect(utils.update).toHaveBeenCalledWith(17, expect.any(Object)));
    expect(utils.create).not.toHaveBeenCalled();
  });

  it('appends, moves, and removes steps', async () => {
    const utils = mountEditor();
    await waitFor(() => expect(utils.getByTestId('recipe-editor-step-0')).toBeTruthy());
    fireEvent.press(utils.getByTestId('recipe-editor-add-step'));
    expect(utils.getByTestId('recipe-editor-step-1')).toBeTruthy();
    fireEvent.press(utils.getByTestId('recipe-editor-step-1-up'));
    fireEvent.press(utils.getByTestId('recipe-editor-step-0-remove'));
    expect(utils.queryByTestId('recipe-editor-step-1')).toBeNull();
  });

  it('rejects duplicate tag slugs in tallied mode', async () => {
    const utils = mountEditor();
    await waitFor(() => expect(utils.getByTestId('recipe-editor-step-0')).toBeTruthy());
    fireEvent.press(utils.getByTestId('recipe-editor-add-step'));
    // Select 'red' on step 1 via the tag dropdown (step 0 already holds 'red')
    await waitFor(() => expect(utils.getByTestId('tag-picker-1-trigger')).toBeTruthy());
    fireEvent.press(utils.getByTestId('tag-picker-1-trigger'));
    await waitFor(() => expect(utils.getByTestId('tag-picker-1-option-red')).toBeTruthy());
    fireEvent.press(utils.getByTestId('tag-picker-1-option-red'));
    // Need a prompt for step 1 to clear the prompt error
    fireEvent.changeText(utils.getByTestId('recipe-editor-step-1-prompt'), 'Find red again');
    await waitFor(() => expect(utils.getByTestId('recipe-editor-errors')).toBeTruthy());
  });

  it('hides the rounds field for sense_grounding', async () => {
    const utils = mountEditor({
      mode: 'sense_grounding',
      initialDraft: makeDraft({ mode: 'sense_grounding', name: 'x' }),
    });
    expect(utils.queryByTestId('recipe-editor-rounds-value')).toBeNull();
  });

  it('clamps the rounds stepper between 1 and the max', async () => {
    const utils = mountEditor();
    await waitFor(() => expect(utils.getByTestId('recipe-editor-step-0')).toBeTruthy());
    expect(utils.getByTestId('recipe-editor-rounds-value').props.children).toBe(1);
    fireEvent.press(utils.getByTestId('recipe-editor-rounds-minus'));
    expect(utils.getByTestId('recipe-editor-rounds-value').props.children).toBe(1);
    fireEvent.press(utils.getByTestId('recipe-editor-rounds-plus'));
    expect(utils.getByTestId('recipe-editor-rounds-value').props.children).toBe(2);
  });

  it('clamps the per-step count stepper between 1 and the max', async () => {
    const utils = mountEditor();
    await waitFor(() => expect(utils.getByTestId('recipe-editor-step-0')).toBeTruthy());
    const valueId = 'recipe-editor-step-0-count-value';
    expect(utils.getByTestId(valueId).props.children).toBe(1);
    fireEvent.press(utils.getByTestId('recipe-editor-step-0-count-minus'));
    expect(utils.getByTestId(valueId).props.children).toBe(1);
    fireEvent.press(utils.getByTestId('recipe-editor-step-0-count-plus'));
    expect(utils.getByTestId(valueId).props.children).toBe(2);
  });

  it('moves a step down and disables the boundary move buttons', async () => {
    const utils = mountEditor();
    await waitFor(() => expect(utils.getByTestId('recipe-editor-step-0')).toBeTruthy());
    fireEvent.press(utils.getByTestId('recipe-editor-add-step'));
    expect(utils.getByTestId('recipe-editor-step-0-up').props.accessibilityState.disabled).toBe(
      true,
    );
    expect(utils.getByTestId('recipe-editor-step-1-down').props.accessibilityState.disabled).toBe(
      true,
    );
    fireEvent.changeText(utils.getByTestId('recipe-editor-step-0-prompt'), 'moved');
    fireEvent.press(utils.getByTestId('recipe-editor-step-0-down'));
    expect(utils.getByTestId('recipe-editor-step-1-prompt').props.value).toBe('moved');
  });

  it('pressing a disabled move button is a no-op', async () => {
    const utils = mountEditor();
    await waitFor(() => expect(utils.getByTestId('recipe-editor-step-0')).toBeTruthy());
    fireEvent.press(utils.getByTestId('recipe-editor-step-0-up'));
    expect(utils.getByTestId('recipe-editor-step-0-prompt').props.value).toBe('Find red');
  });

  it('renders an inline API error banner when save fails', async () => {
    const create = jest.fn(async (_payload: unknown) => {
      throw new Error('server exploded');
    });
    const utils = mountEditor({ create: create as never });
    await waitFor(() => expect(utils.listTags).toHaveBeenCalled());
    await act(async () => {
      fireEvent.press(utils.getByTestId('recipe-editor-save'));
    });
    await waitFor(() => expect(utils.getByTestId('recipe-editor-api-error')).toBeTruthy());
    expect(utils.onSaved).not.toHaveBeenCalled();
  });

  it('leaves the tag library empty when listTags rejects', async () => {
    const listTags = jest.fn(async (): Promise<PracticeTag[]> => {
      throw new Error('tags down');
    });
    const utils = mountEditor({ listTags: listTags as never });
    await waitFor(() => expect(listTags).toHaveBeenCalled());
    expect(utils.getByTestId('recipe-editor-step-0')).toBeTruthy();
  });
});
