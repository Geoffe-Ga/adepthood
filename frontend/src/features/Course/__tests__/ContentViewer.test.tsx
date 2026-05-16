/* eslint-env jest */
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

import type * as Api from '../../../api';
import type { ContentItem } from '../../../api';
import ContentViewer from '../ContentViewer';

jest.mock('../../../api', () => ({
  course: {
    markRead: jest.fn(),
    contentBody: jest.fn(),
  },
}));

const { course: courseApi } = jest.requireMock('../../../api') as {
  course: {
    markRead: jest.MockedFunction<typeof Api.course.markRead>;
    contentBody: jest.MockedFunction<typeof Api.course.contentBody>;
  };
};

const HAPPY_BODY = {
  url: 'https://aptitude.guru/course/beige-1',
  title: 'Chapter One',
  body_html: '<article><h1>Chapter One</h1><p>Hi.</p></article>',
};

const HAPPY_COMPLETION = {
  id: 1,
  user_id: 1,
  content_id: 1,
  completed_at: '2026-01-15T10:00:00Z',
};

function makeItem(overrides: Partial<ContentItem> = {}): ContentItem {
  return {
    id: 1,
    title: 'Test Article',
    content_type: 'chapter',
    release_day: 0,
    url: 'https://aptitude.guru/course/beige-1',
    is_locked: false,
    is_read: false,
    ...overrides,
  };
}

describe('ContentViewer', () => {
  let onBack: jest.Mock;
  let onMarkRead: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    onBack = jest.fn();
    onMarkRead = jest.fn();
    courseApi.markRead.mockResolvedValue(HAPPY_COMPLETION);
    courseApi.contentBody.mockResolvedValue(HAPPY_BODY);
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
      expect(courseApi.contentBody).toHaveBeenCalledWith(item.id);
    });
  });

  it('renders the cleaned HTML inside a WebView', async () => {
    const item = makeItem();
    const { findByTestId } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} />,
    );
    const webview = await findByTestId('reader-webview');
    const html = String(webview.props['data-source-html']);
    expect(html).toContain('<article>');
    expect(html).toContain('Chapter One');
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
      expect(courseApi.markRead).toHaveBeenCalledWith(1);
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
    expect(courseApi.markRead).not.toHaveBeenCalled();
  });

  it('shows the reflect button when the item is read', async () => {
    const item = makeItem({ is_read: true });
    const onReflect = jest.fn();
    const { getByTestId, getByText, findByTestId } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} onReflect={onReflect} />,
    );
    await findByTestId('reader-webview');
    expect(getByTestId('reflect-button')).toBeTruthy();
    expect(getByText('Reflect in Journal')).toBeTruthy();
  });

  it('shows the reflect button after marking content as read', async () => {
    const item = makeItem({ is_read: false });
    const onReflect = jest.fn();
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
    const onReflect = jest.fn();
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
    courseApi.contentBody.mockRejectedValueOnce({ detail: 'cms_unavailable' });
    const item = makeItem();
    const { findByTestId, getByText } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} />,
    );
    await findByTestId('reader-error');
    expect(getByText(/temporarily unreachable/i)).toBeTruthy();

    courseApi.contentBody.mockResolvedValueOnce({
      url: 'https://aptitude.guru/course/beige-1',
      title: 'Chapter One',
      body_html: '<article>retry worked</article>',
    });
    fireEvent.press(await findByTestId('reader-retry-button'));
    const webview = await findByTestId('reader-webview');
    expect(String(webview.props['data-source-html'])).toContain('retry worked');
  });

  it('shows a server-config message when the CMS auth detail comes back', async () => {
    courseApi.contentBody.mockRejectedValueOnce({ detail: 'cms_auth_failed' });
    const item = makeItem();
    const { findByText } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} />,
    );
    await findByText(/site password is not set/i);
  });
});
