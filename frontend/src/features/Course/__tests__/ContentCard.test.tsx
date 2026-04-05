/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { render, fireEvent } from '@testing-library/react-native';

import type { ContentItem } from '../../../api';
import ContentCard from '../ContentCard';

const makeItem = (overrides: Partial<ContentItem> = {}): ContentItem => ({
  id: 1,
  title: 'Introduction to Awareness',
  content_type: 'essay',
  release_day: 0,
  url: 'https://example.com/essay-1',
  is_locked: false,
  is_read: false,
  ...overrides,
});

describe('ContentCard', () => {
  let onPress: jest.Mock;

  beforeEach(() => {
    onPress = jest.fn() as any;
  });

  it('renders the content title', () => {
    const item = makeItem();
    const { getByText } = render(<ContentCard item={item} onPress={onPress} />);
    expect(getByText('Introduction to Awareness')).toBeTruthy();
  });

  it('shows essay icon for essay content type', () => {
    const item = makeItem({ content_type: 'essay' });
    const { getByText } = render(<ContentCard item={item} onPress={onPress} />);
    expect(getByText('📖')).toBeTruthy();
  });

  it('shows prompt icon for prompt content type', () => {
    const item = makeItem({ content_type: 'prompt' });
    const { getByText } = render(<ContentCard item={item} onPress={onPress} />);
    expect(getByText('💬')).toBeTruthy();
  });

  it('shows video icon for video content type', () => {
    const item = makeItem({ content_type: 'video' });
    const { getByText } = render(<ContentCard item={item} onPress={onPress} />);
    expect(getByText('▶')).toBeTruthy();
  });

  it('shows unlock date for locked items', () => {
    const item = makeItem({ is_locked: true, release_day: 7 });
    const { getByText } = render(<ContentCard item={item} onPress={onPress} />);
    expect(getByText('Unlocks on day 7')).toBeTruthy();
  });

  it('shows completed text for read items', () => {
    const item = makeItem({ is_read: true });
    const { getByText } = render(<ContentCard item={item} onPress={onPress} />);
    expect(getByText('Completed')).toBeTruthy();
  });

  it('shows content type as subtitle for unlocked unread items', () => {
    const item = makeItem({ content_type: 'essay' });
    const { getByText } = render(<ContentCard item={item} onPress={onPress} />);
    expect(getByText('Essay')).toBeTruthy();
  });

  it('calls onPress when unlocked item is tapped', () => {
    const item = makeItem();
    const { getByTestId } = render(<ContentCard item={item} onPress={onPress} />);
    fireEvent.press(getByTestId('content-card-1'));
    expect(onPress).toHaveBeenCalledWith(item);
  });

  it('does not call onPress when locked item is tapped', () => {
    const item = makeItem({ is_locked: true });
    const { getByTestId } = render(<ContentCard item={item} onPress={onPress} />);
    fireEvent.press(getByTestId('content-card-1'));
    expect(onPress).not.toHaveBeenCalled();
  });

  it('shows lock icon for locked items', () => {
    const item = makeItem({ is_locked: true });
    const { getByText } = render(<ContentCard item={item} onPress={onPress} />);
    expect(getByText('🔒')).toBeTruthy();
  });

  it('shows checkmark for read items', () => {
    const item = makeItem({ is_read: true });
    const { getByText } = render(<ContentCard item={item} onPress={onPress} />);
    expect(getByText('✓')).toBeTruthy();
  });
});
