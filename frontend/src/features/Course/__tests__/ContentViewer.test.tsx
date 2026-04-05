/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Linking } from 'react-native';

import type { ContentItem } from '../../../api';

const mockMarkRead = (jest.fn() as any).mockResolvedValue({
  id: 1,
  user_id: 1,
  content_id: 1,
  completed_at: '2026-01-15T10:00:00Z',
});

jest.mock('../../../api', () => ({
  course: {
    markRead: (...args: unknown[]) => mockMarkRead(...args),
  },
}));

// eslint-disable-next-line import/order
const { render, fireEvent, waitFor, act } = require('@testing-library/react-native');
const ContentViewer = require('../ContentViewer').default;

const makeItem = (overrides: Partial<ContentItem> = {}): ContentItem => ({
  id: 1,
  title: 'Test Article',
  content_type: 'essay',
  release_day: 0,
  url: 'https://example.com/article',
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
  });

  it('renders the content title', () => {
    const item = makeItem();
    const { getByText } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} />,
    );
    expect(getByText('Test Article')).toBeTruthy();
  });

  it('calls onBack when back button is pressed', () => {
    const item = makeItem();
    const { getByTestId } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} />,
    );
    fireEvent.press(getByTestId('viewer-back-button'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('opens URL when open in browser is pressed', () => {
    const openURLSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as any);
    const item = makeItem({ url: 'https://example.com/test' });
    const { getByTestId } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} />,
    );

    fireEvent.press(getByTestId('open-url-button'));
    expect(openURLSpy).toHaveBeenCalledWith('https://example.com/test');
    openURLSpy.mockRestore();
  });

  it('marks content as read when button is pressed', async () => {
    const item = makeItem();
    const { getByTestId, getByText } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} />,
    );

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

  it('shows already read state when item is pre-read', () => {
    const item = makeItem({ is_read: true });
    const { getByText } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} />,
    );
    expect(getByText('✓ Read')).toBeTruthy();
  });

  it('disables mark-read button when already read', () => {
    const item = makeItem({ is_read: true });
    const { getByTestId } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} />,
    );

    fireEvent.press(getByTestId('mark-read-button'));
    expect(mockMarkRead).not.toHaveBeenCalled();
  });
});
