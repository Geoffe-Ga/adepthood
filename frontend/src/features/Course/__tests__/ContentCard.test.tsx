/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-env jest */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { render, fireEvent } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import type { ContentItem } from '../../../api';
import { colors, surface } from '../../../design/tokens';
import ContentCard from '../ContentCard';

const DEFAULT_ICON = '📄';

const iconBackground = (style: unknown): unknown =>
  (StyleSheet.flatten(style as never) as { backgroundColor?: unknown }).backgroundColor;

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

  it('shows a non-default icon for the production chapter content type', () => {
    const item = makeItem({ content_type: 'chapter' });
    const { getByText, queryByText } = render(<ContentCard item={item} onPress={onPress} />);
    expect(getByText('📚')).toBeTruthy();
    expect(queryByText(DEFAULT_ICON)).toBeNull();
  });

  it('gives the chapter icon badge a non-default themed background', () => {
    const item = makeItem({ id: 42, content_type: 'chapter' });
    const { getByTestId } = render(<ContentCard item={item} onPress={onPress} />);
    const background = iconBackground(getByTestId('content-card-icon-42').props.style);
    expect(background).toBe(colors.tier.stretch);
    expect(background).not.toBe(surface.sunken);
  });

  it('falls back to the default icon and background for an unknown content type', () => {
    const item = makeItem({ id: 7, content_type: 'mystery' });
    const { getByText, getByTestId } = render(<ContentCard item={item} onPress={onPress} />);
    expect(getByText(DEFAULT_ICON)).toBeTruthy();
    expect(iconBackground(getByTestId('content-card-icon-7').props.style)).toBe(surface.sunken);
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
