/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const mockSiteResources = (jest.fn() as any).mockResolvedValue([
  {
    slug: 'philosophy',
    title: 'Philosophy',
    description: '',
    url: 'https://aptitude.guru/philosophy',
  },
  { slug: 'about', title: 'About', description: '', url: 'https://aptitude.guru/about' },
]);

jest.mock('../../../api', () => ({
  course: {
    siteResources: (...args: unknown[]) => mockSiteResources(...args),
  },
}));

// eslint-disable-next-line import/order
const { render, fireEvent, waitFor } = require('@testing-library/react-native');
const SiteResourcesPanel = require('../SiteResourcesPanel').default;

describe('SiteResourcesPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSiteResources.mockResolvedValue([
      {
        slug: 'philosophy',
        title: 'Philosophy',
        description: '',
        url: 'https://aptitude.guru/philosophy',
      },
      { slug: 'about', title: 'About', description: '', url: 'https://aptitude.guru/about' },
    ]);
  });

  it('renders nothing while loading', () => {
    mockSiteResources.mockReturnValueOnce(new Promise(() => {}));
    const onSelect = jest.fn() as any;
    const { queryByTestId } = render(<SiteResourcesPanel onSelect={onSelect} />);
    expect(queryByTestId('site-resources-panel')).toBeNull();
  });

  it('renders one chip per configured resource', async () => {
    const onSelect = jest.fn() as any;
    const { findByTestId, getByText } = render(<SiteResourcesPanel onSelect={onSelect} />);
    await findByTestId('site-resources-panel');
    expect(getByText('Philosophy')).toBeTruthy();
    expect(getByText('About')).toBeTruthy();
  });

  it('passes the resource back to onSelect when a chip is pressed', async () => {
    const onSelect = jest.fn() as any;
    const { findByTestId } = render(<SiteResourcesPanel onSelect={onSelect} />);
    const chip = await findByTestId('site-resource-chip-philosophy');
    fireEvent.press(chip);
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'philosophy', title: 'Philosophy' }),
    );
  });

  it('stays silent (no panel) when the API call rejects', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockSiteResources.mockRejectedValueOnce(new Error('nope'));
    const onSelect = jest.fn() as any;
    const { queryByTestId } = render(<SiteResourcesPanel onSelect={onSelect} />);
    await waitFor(() => {
      expect(warn).toHaveBeenCalled();
    });
    expect(queryByTestId('site-resources-panel')).toBeNull();
    warn.mockRestore();
  });

  it('hides the panel entirely when the resource list is empty', async () => {
    mockSiteResources.mockResolvedValueOnce([]);
    const onSelect = jest.fn() as any;
    const { queryByTestId } = render(<SiteResourcesPanel onSelect={onSelect} />);
    await waitFor(() => {
      expect(mockSiteResources).toHaveBeenCalled();
    });
    expect(queryByTestId('site-resources-panel')).toBeNull();
  });
});
