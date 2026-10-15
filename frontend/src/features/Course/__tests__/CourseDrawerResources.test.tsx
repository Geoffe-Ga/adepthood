import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import CourseDrawer from '../CourseDrawer';

const resources = [
  {
    slug: 'about',
    title: 'About',
    description: '',
    url: 'content://about',
    order: 1,
    is_read: true,
  },
  {
    slug: 'energy-scaffolding',
    title: 'Energy Scaffolding',
    description: '',
    url: 'content://energy-scaffolding',
    order: 2,
    is_read: false,
  },
];
const props = {
  stages: [],
  selectedStage: 2,
  sections: {},
  bodies: {},
  sweepStatus: 'idle' as const,
  onChapterPress: jest.fn(),
  onRetry: jest.fn(),
  onConfirmBodySearch: jest.fn(),
  resources,
  onResourcePress: jest.fn(),
};
describe('Start Here in the Course drawer', () => {
  it('opens the served resource with its actual known read mark', () => {
    const view = render(<CourseDrawer {...props} />);
    fireEvent.press(view.getByLabelText('Open About, read'));
    expect(props.onResourcePress).toHaveBeenCalledWith(resources[0]);
  });
  it('keeps a failed Start Here lookup retryable beside an explicit Frequency route', () => {
    const retry = jest.fn();
    const view = render(
      <CourseDrawer {...props} resources={[]} resourceStatus="error" onResourcesRetry={retry} />,
    );
    fireEvent.press(view.getByText("Start Here couldn't load. Tap to retry."));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('marks the resource currently being read independently of the underlying Frequency', () => {
    const view = render(<CourseDrawer {...props} activeResourceSlug="about" />);
    expect(view.getByLabelText('Open About, read').props.accessibilityState).toMatchObject({
      selected: true,
    });
    expect(view.getByLabelText('Open Energy Scaffolding').props.accessibilityState).toMatchObject({
      selected: false,
    });
  });
});
