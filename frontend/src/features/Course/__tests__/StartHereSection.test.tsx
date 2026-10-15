import { describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';

import StartHereSection from '../StartHereSection';

import type { SiteResource } from '@/api';

const resources: SiteResource[] = [
  {
    slug: 'about',
    title: 'About',
    description: 'An introduction',
    url: 'content://about',
    order: 1,
    is_read: true,
  },
  {
    slug: 'energy-scaffolding',
    title: 'Energy Scaffolding',
    description: 'Choose what fits',
    url: 'content://energy-scaffolding',
    order: 2,
    is_read: false,
  },
];
const progress = { total_items: 2, read_items: 1, progress_percent: 50, next_unlock_day: null };
const props = {
  resources,
  progress,
  status: 'ready' as const,
  onSelect: jest.fn(),
  onRetry: jest.fn(),
  onStartEnergy: jest.fn(),
  habitsEnabled: true,
};
describe('Start Here reading section', () => {
  it('shows actual resource titles, descriptions, confirmed marks and progress', () => {
    const view = render(<StartHereSection {...props} />);
    expect(view.getByText('1 of 2 read')).toBeTruthy();
    expect(view.getByText('An introduction')).toBeTruthy();
    expect(view.getByLabelText('Open About, read')).toBeTruthy();
    fireEvent.press(view.getByLabelText('Open Energy Scaffolding'));
    expect(props.onSelect).toHaveBeenCalledWith(resources[1]);
  });
  it('offers the existing Energy onboarding only when Habits is enabled', () => {
    const view = render(<StartHereSection {...props} />);
    fireEvent.press(view.getByText('Start Energy Scaffolding'));
    expect(props.onStartEnergy).toHaveBeenCalledTimes(1);
    view.rerender(<StartHereSection {...props} habitsEnabled={false} />);
    expect(view.queryByText('Start Energy Scaffolding')).toBeNull();
  });
  it('keeps a failed read distinct from an empty completed catalog and offers retry', () => {
    const view = render(
      <StartHereSection {...props} resources={[]} progress={null} status="error" />,
    );
    expect(view.queryByText('0 of 0 read')).toBeNull();
    fireEvent.press(view.getByText('Try again'));
    expect(props.onRetry).toHaveBeenCalled();
  });
});
