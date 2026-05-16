/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

import type { ContentItem } from '../../../api';

const mockMarkRead = (jest.fn() as any).mockResolvedValue({
  id: 1,
  user_id: 1,
  content_id: 1,
  completed_at: '2026-01-15T10:00:00Z',
});

const mockContentBody = (jest.fn() as any).mockResolvedValue({
  url: 'https://aptitude.guru/course/beige-1',
  title: 'Chapter One',
  body_html: '<article><h1>Chapter One</h1><p>Hi.</p></article>',
});

jest.mock('../../../api', () => ({
  course: {
    markRead: (...args: unknown[]) => mockMarkRead(...args),
    contentBody: (...args: unknown[]) => mockContentBody(...args),
  },
}));

// eslint-disable-next-line import/order
const { render, fireEvent, waitFor, act } = require('@testing-library/react-native');
const ContentViewer = require('../ContentViewer').default;

const makeItem = (overrides: Partial<ContentItem> = {}): ContentItem => ({
  id: 1,
  title: 'Test Article',
  content_type: 'chapter',
  release_day: 0,
  url: 'https://aptitude.guru/course/beige-1',
  is_locked: false,
  is_read: false,
  ...overrides,
});

describe('ContentViewer', () => {
  let onBack: jest.Mock;
  let onMarkRead: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    onBack = jest.fn() as any;
    onMarkRead = jest.fn() as any;
    mockMarkRead.mockResolvedValue({
      id: 1,
      user_id: 1,
      content_id: 1,
      completed_at: '2026-01-15T10:00:00Z',
    });
    mockContentBody.mockResolvedValue({
      url: 'https://aptitude.guru/course/beige-1',
      title: 'Chapter One',
      body_html: '<article><h1>Chapter One</h1><p>Hi.</p></article>',
    });
  });

  it('renders the content title initially, then swaps to the live title', async () => {
    const item = makeItem({ title: 'Loading Title' });
    const { getByText, findByText } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} />,
    );
    expect(getByText('Loading Title')).toBeTruthy();
    await findByText('Chapter One');
  });

  it('fetches the content body via the API', async () => {
    const item = makeItem();
    render(<ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} />);
    await waitFor(() => {
      expect(mockContentBody).toHaveBeenCalledWith(item.id);
    });
  });

  it('renders the cleaned HTML inside a WebView', async () => {
    const item = makeItem();
    const { findByTestId } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} />,
    );
    const webview = await findByTestId('reader-webview');
    expect(webview.props['data-source-html']).toContain('<article>');
    expect(webview.props['data-source-html']).toContain('Chapter One');
  });

  it('calls onBack when back button is pressed', async () => {
    const item = makeItem();
    const { getByTestId, findByTestId } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} />,
    );
    // Wait until the load settles so we don't hit "state update on unmounted".
    await findByTestId('reader-webview');
    fireEvent.press(getByTestId('reader-back-button'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('marks content as read when the button is pressed', async () => {
    const item = makeItem();
    const { getByTestId, getByText, findByText } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} />,
    );
    await findByText('Chapter One');
    expect(getByText('Mark as Read')).toBeTruthy();

    await act(async () => {
      fireEvent.press(getByTestId('mark-read-button'));
    });

    await waitFor(() => {
      expect(mockMarkRead).toHaveBeenCalledWith(1);
      expect(onMarkRead).toHaveBeenCalledTimes(1);
      expect(getByText('✓ Read')).toBeTruthy();
    });
  });

  it('shows already-read state when item is pre-read', async () => {
    const item = makeItem({ is_read: true });
    const { getByText, findByTestId } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} />,
    );
    await findByTestId('reader-webview');
    expect(getByText('✓ Read')).toBeTruthy();
  });

  it('disables mark-read when already read', async () => {
    const item = makeItem({ is_read: true });
    const { getByTestId, findByTestId } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} />,
    );
    await findByTestId('reader-webview');
    fireEvent.press(getByTestId('mark-read-button'));
    expect(mockMarkRead).not.toHaveBeenCalled();
  });

  it('shows the reflect button when the item is read', async () => {
    const item = makeItem({ is_read: true });
    const onReflect = jest.fn() as any;
    const { getByTestId, getByText, findByTestId } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} onReflect={onReflect} />,
    );
    await findByTestId('reader-webview');
    expect(getByTestId('reflect-button')).toBeTruthy();
    expect(getByText('Reflect in Journal')).toBeTruthy();
  });

  it('shows the reflect button after marking content as read', async () => {
    const item = makeItem({ is_read: false });
    const onReflect = jest.fn() as any;
    const { getByTestId, queryByTestId, findByTestId } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} onReflect={onReflect} />,
    );
    await findByTestId('reader-webview');
    expect(queryByTestId('reflect-button')).toBeNull();

    await act(async () => {
      fireEvent.press(getByTestId('mark-read-button'));
    });

    await waitFor(() => {
      expect(getByTestId('reflect-button')).toBeTruthy();
    });
  });

  it('calls onReflect when the reflect button is pressed', async () => {
    const item = makeItem({ is_read: true });
    const onReflect = jest.fn() as any;
    const { getByTestId, findByTestId } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} onReflect={onReflect} />,
    );
    await findByTestId('reader-webview');
    fireEvent.press(getByTestId('reflect-button'));
    expect(onReflect).toHaveBeenCalledTimes(1);
  });

  it('omits the reflect button when no callback is provided', async () => {
    const item = makeItem({ is_read: true });
    const { queryByTestId, findByTestId } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} />,
    );
    await findByTestId('reader-webview');
    expect(queryByTestId('reflect-button')).toBeNull();
  });

  it('surfaces a retry UI when the content body fails to load', async () => {
    mockContentBody.mockRejectedValueOnce({ detail: 'cms_unavailable' });
    const item = makeItem();
    const { findByTestId, getByText } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} />,
    );
    await findByTestId('reader-error');
    expect(getByText(/temporarily unreachable/i)).toBeTruthy();

    mockContentBody.mockResolvedValueOnce({
      url: 'https://aptitude.guru/course/beige-1',
      title: 'Chapter One',
      body_html: '<article>retry worked</article>',
    });
    fireEvent.press(await findByTestId('reader-retry-button'));
    const webview = await findByTestId('reader-webview');
    expect(webview.props['data-source-html']).toContain('retry worked');
  });

  it('shows a server-config message when the CMS auth detail comes back', async () => {
    mockContentBody.mockRejectedValueOnce({ detail: 'cms_auth_failed' });
    const item = makeItem();
    const { findByText } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} />,
    );
    await findByText(/site password is not set/i);
  });
});
