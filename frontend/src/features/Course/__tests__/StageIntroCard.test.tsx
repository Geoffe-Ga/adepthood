/* eslint-env jest */
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import type * as Api from '../../../api';
import StageIntroCard from '../StageIntroCard';

jest.mock('../../../api', () => ({
  course: {
    stageIntro: jest.fn(),
  },
}));

const { course: courseApi } = jest.requireMock('../../../api') as {
  course: { stageIntro: jest.MockedFunction<typeof Api.course.stageIntro> };
};
const mockStageIntro = courseApi.stageIntro;

const INTRO = {
  stage: 1,
  id: 'beige-intro',
  slug: 'beige-introduction',
  title: 'Welcome to Beige',
  summary: 'What Beige is about.',
};

describe('StageIntroCard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the intro title + summary and fires onOpen with the stage on press', async () => {
    mockStageIntro.mockResolvedValue(INTRO);
    const onOpen = jest.fn();
    const { getByTestId, getByText } = render(<StageIntroCard stageNumber={1} onOpen={onOpen} />);

    await waitFor(() => expect(getByTestId('stage-intro-card')).toBeTruthy());
    expect(getByText('Welcome to Beige')).toBeTruthy();
    expect(getByText('What Beige is about.')).toBeTruthy();

    fireEvent.press(getByTestId('stage-intro-card'));
    expect(onOpen).toHaveBeenCalledWith(1);
  });

  it('renders nothing when the stage has no intro (404)', async () => {
    mockStageIntro.mockRejectedValue({ detail: 'content_not_found' });
    const { queryByTestId } = render(<StageIntroCard stageNumber={2} onOpen={jest.fn()} />);

    await waitFor(() => expect(mockStageIntro).toHaveBeenCalledWith(2));
    expect(queryByTestId('stage-intro-card')).toBeNull();
  });

  it('renders without a summary when none is provided', async () => {
    mockStageIntro.mockResolvedValue({ ...INTRO, summary: null });
    const { getByTestId, queryByText } = render(
      <StageIntroCard stageNumber={1} onOpen={jest.fn()} />,
    );

    await waitFor(() => expect(getByTestId('stage-intro-card')).toBeTruthy());
    expect(queryByText('What Beige is about.')).toBeNull();
  });
});
