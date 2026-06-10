/* eslint-env jest */
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import type * as Api from '../../../api';
import SiteResourcesPanel from '../SiteResourcesPanel';

jest.mock('../../../api', () => ({
  course: {
    siteResources: jest.fn(),
  },
}));

const { course: courseApi } = jest.requireMock('../../../api') as {
  course: { siteResources: jest.MockedFunction<typeof Api.course.siteResources> };
};

const SAMPLE = [
  {
    slug: 'philosophy',
    title: 'Philosophy',
    description: '',
    url: 'content://philosophy',
  },
  {
    slug: 'about',
    title: 'About',
    description: '',
    url: 'content://about',
  },
];

describe('SiteResourcesPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    courseApi.siteResources.mockResolvedValue(SAMPLE);
  });

  it('renders nothing while loading', () => {
    courseApi.siteResources.mockReturnValueOnce(new Promise(() => undefined));
    const { queryByTestId } = render(<SiteResourcesPanel onSelect={jest.fn()} />);
    expect(queryByTestId('site-resources-panel')).toBeNull();
  });

  it('renders one chip per configured resource', async () => {
    const { findByTestId, getByText } = render(<SiteResourcesPanel onSelect={jest.fn()} />);
    await findByTestId('site-resources-panel');
    expect(getByText('Philosophy')).toBeTruthy();
    expect(getByText('About')).toBeTruthy();
  });

  it('passes the resource back to onSelect when a chip is pressed', async () => {
    const onSelect = jest.fn();
    const { findByTestId } = render(<SiteResourcesPanel onSelect={onSelect} />);
    const chip = await findByTestId('site-resource-chip-philosophy');
    fireEvent.press(chip);
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'philosophy', title: 'Philosophy' }),
    );
  });

  it('stays silent (no panel) when the API call rejects', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    courseApi.siteResources.mockRejectedValueOnce(new Error('nope'));
    const { queryByTestId } = render(<SiteResourcesPanel onSelect={jest.fn()} />);
    await waitFor(() => {
      expect(warn).toHaveBeenCalled();
    });
    expect(queryByTestId('site-resources-panel')).toBeNull();
    warn.mockRestore();
  });

  it('hides the panel entirely when the resource list is empty', async () => {
    courseApi.siteResources.mockResolvedValueOnce([]);
    const { queryByTestId } = render(<SiteResourcesPanel onSelect={jest.fn()} />);
    await waitFor(() => {
      expect(courseApi.siteResources).toHaveBeenCalled();
    });
    expect(queryByTestId('site-resources-panel')).toBeNull();
  });
});
