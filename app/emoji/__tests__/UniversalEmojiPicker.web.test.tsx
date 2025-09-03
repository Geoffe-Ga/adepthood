/* eslint-env jest */
import { describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { EmojiPreferencesProvider } from '../emoji-prefs';
import { UniversalEmojiPicker } from '../UniversalEmojiPicker';

jest.mock('react-native', () => {
  const React = require('react');
  return {
    Platform: { OS: 'web' },
    View: (props: any) => React.createElement('div', props, props.children),
    Button: (props: any) => React.createElement('button', props, props.children),
  };
});

const mockPicker = jest.fn();
jest.mock(
  '@emoji-mart/react',
  () => (props: any) => {
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
    const props = mockPicker.mock.calls[0][0];
    expect(props.emojiSize).toBe(24);
    expect(props.perLine).toBe(8);
    expect(props.dynamicWidth).toBe(false);
    expect(props.style).toMatchObject({ width: 320 });
    expect(props.style).toMatchObject({ maxHeight: 300 });
  });
});
