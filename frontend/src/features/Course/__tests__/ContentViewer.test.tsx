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

  it('shows reflect button when item has been read', () => {
    const item = makeItem({ is_read: true });
    const onReflect = jest.fn() as any;
    const { getByTestId, getByText } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} onReflect={onReflect} />,
    );
    expect(getByTestId('reflect-button')).toBeTruthy();
    expect(getByText('Reflect in Journal')).toBeTruthy();
  });

  it('shows reflect button after marking content as read', async () => {
    const item = makeItem({ is_read: false });
    const onReflect = jest.fn() as any;
    const { getByTestId, queryByTestId } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} onReflect={onReflect} />,
    );

    // Initially no reflect button
    expect(queryByTestId('reflect-button')).toBeNull();

    await act(async () => {
      fireEvent.press(getByTestId('mark-read-button'));
    });

    await waitFor(() => {
      expect(getByTestId('reflect-button')).toBeTruthy();
    });
  });

  it('calls onReflect when reflect button is pressed', () => {
    const item = makeItem({ is_read: true });
    const onReflect = jest.fn() as any;
    const { getByTestId } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} onReflect={onReflect} />,
    );

    fireEvent.press(getByTestId('reflect-button'));
    expect(onReflect).toHaveBeenCalledTimes(1);
  });

  it('does not render reflect button when onReflect is not provided', () => {
    const item = makeItem({ is_read: true });
    const { queryByTestId } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} />,
    );
    expect(queryByTestId('reflect-button')).toBeNull();
  });

  it('does not open javascript: URLs', () => {
    const openURLSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as any);
    const item = makeItem({ url: 'javascript:alert(1)' });
    const { getByTestId } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} />,
    );

    fireEvent.press(getByTestId('open-url-button'));
    expect(openURLSpy).not.toHaveBeenCalled();
    openURLSpy.mockRestore();
  });

  it('does not open tel: URLs', () => {
    const openURLSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as any);
    const item = makeItem({ url: 'tel:+1234567890' });
    const { getByTestId } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} />,
    );

    fireEvent.press(getByTestId('open-url-button'));
    expect(openURLSpy).not.toHaveBeenCalled();
    openURLSpy.mockRestore();
  });

  it('does not open file: URLs', () => {
    const openURLSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as any);
    const item = makeItem({ url: 'file:///etc/passwd' });
    const { getByTestId } = render(
      <ContentViewer item={item} onBack={onBack} onMarkRead={onMarkRead} />,
    );

    fireEvent.press(getByTestId('open-url-button'));
    expect(openURLSpy).not.toHaveBeenCalled();
    openURLSpy.mockRestore();
  });
});
