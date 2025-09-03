/* eslint-env jest */

import { describe, expect, it, jest } from '@jest/globals';
import React from 'react';

import { EmojiPreferencesProvider } from '../emoji-prefs';
import { GLYPH_SIZE, NUM_COLUMNS, PANEL_HEIGHT, PANEL_WIDTH } from '../emojiPickerLayout';
import { UniversalEmojiPicker } from '../UniversalEmojiPicker';

import TestRenderer, { act } from 'react-test-renderer';

interface PickerMockProps {
  emojiSize: number;
  perLine: number;
  dynamicWidth: boolean;
  style: Record<string, unknown>;
}

jest.mock('react-native', () => {
  const React = require('react');
  return {
    Platform: { OS: 'web' },
    View: (props: { children?: React.ReactNode } & Record<string, unknown>) =>
      React.createElement('div', props, props.children),
    Button: (props: { children?: React.ReactNode } & Record<string, unknown>) =>
      React.createElement('button', props, props.children),
  };
});

const mockPicker = jest.fn();
jest.mock(
  '@emoji-mart/react',
  () => (props: PickerMockProps) => {
    mockPicker(props);
    return null;
  },
  { virtual: true },
);

jest.mock('@emoji-mart/data', () => ({}), { virtual: true });
jest.mock('emoji-mart-native', () => jest.fn(), { virtual: true });
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => {}),
  removeItem: jest.fn(async () => {}),
}));
jest.mock('../../services/emojiApi', () => ({
  getEmojiPrefs: jest.fn(async () => ({ recents: [], preferred_skin_tone: null })),
  patchEmojiPrefs: jest.fn(async () => ({})),
}));

const defaultProps = {
  visible: true,
  onClose: () => {},
  onSelect: () => {},
};

describe('UniversalEmojiPicker web layout', () => {
  it('limits emoji size and container dimensions', async () => {
    await act(async () => {
      TestRenderer.create(
        <EmojiPreferencesProvider>
          <UniversalEmojiPicker {...defaultProps} />
        </EmojiPreferencesProvider>,
      );
    });
    expect(mockPicker).toHaveBeenCalled();
    const props = mockPicker.mock.calls[0]![0] as PickerMockProps;
    expect(props.emojiSize).toBe(GLYPH_SIZE);
    expect(props.perLine).toBe(NUM_COLUMNS);
    expect(props.dynamicWidth).toBe(false);
    expect(props.style).toMatchObject({ width: PANEL_WIDTH });
    expect(props.style).toMatchObject({ height: PANEL_HEIGHT });
    expect(props.style).toMatchObject({ fontSize: GLYPH_SIZE });
  });
});
