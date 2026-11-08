/* eslint-env jest */
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import type * as ReactNative from 'react-native';

import { PracticeStorySection } from '../PracticeStorySection';

import { STAGE_ORDER } from '@/design/tokens';
import { clearServedStages, serveStageColors } from '@/testing/servedStageColors';

const mockRefresh = jest.fn(async () => undefined);
const mockStory: { error: Error | null } = { error: null };

jest.mock('@/features/Practice/hooks/usePracticeStory', () => ({
  usePracticeStory: () => ({
    error: mockStory.error,
    story: null,
    timezone: 'UTC',
    refresh: mockRefresh,
  }),
}));

// The record itself is PracticeStory's to draw and test; this suite only
// proves which stage name the section hands it.
jest.mock('../PracticeStory', () => {
  const { Text } = jest.requireActual<typeof ReactNative>('react-native');
  return {
    PracticeStory: ({ stageName }: { stageName: string }) => (
      <Text testID="practice-story-stage">{stageName}</Text>
    ),
  };
});

/** The stage the section is rendered for, and a served colour its fallback would not give. */
const STAGE = 2;
const SERVED = 'Teal';

afterEach(() => {
  mockStory.error = null;
  mockRefresh.mockClear();
  act(() => clearServedStages());
});

describe('PracticeStorySection', () => {
  it('names the stage by its offline colour before the stages load', () => {
    const { getByTestId } = render(<PracticeStorySection practiceId={1} stageNumber={STAGE} />);
    expect(getByTestId('practice-story-stage').props.children).toBe(STAGE_ORDER[STAGE - 1]);
  });

  it('names the stage by the colour the server served, once it arrives (#2666)', () => {
    const { getByTestId } = render(<PracticeStorySection practiceId={1} stageNumber={STAGE} />);
    act(() => serveStageColors({ [STAGE]: SERVED }));
    expect(getByTestId('practice-story-stage').props.children).toBe(SERVED);
  });

  it('names a stage beyond the ten by its number', () => {
    const beyond = STAGE_ORDER.length + 1;
    const { getByTestId } = render(<PracticeStorySection practiceId={1} stageNumber={beyond} />);
    expect(getByTestId('practice-story-stage').props.children).toBe(`Stage ${beyond}`);
  });

  it('offers a retry when the record could not load', () => {
    mockStory.error = new Error('offline');
    const { getByTestId, getByText } = render(
      <PracticeStorySection practiceId={1} stageNumber={STAGE} />,
    );
    expect(getByTestId('practice-story-error')).toBeTruthy();
    fireEvent.press(getByText('Retry'));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });
});
