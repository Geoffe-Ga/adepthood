/* eslint-env jest */
import { describe, it, expect, jest } from '@jest/globals';
import { render } from '@testing-library/react-native';
import React from 'react';

import HabitEmojiPicker from '../HabitEmojiPicker';

jest.mock('react-native-emoji-selector', () => 'EmojiSelector');

describe('HabitEmojiPicker', () => {
  it('renders the emoji selector with the consistent search placeholder', () => {
    const { UNSAFE_root } = render(<HabitEmojiPicker onEmojiSelected={() => {}} />);
    const selector = UNSAFE_root.findByType('EmojiSelector');

    expect(selector.props.placeholder).toBe('Search emoji...');
    expect(selector.props.showSearchBar).toBe(true);
    expect(selector.props.columns).toBe(6);
    expect(selector.props.emojiSize).toBe(28);
  });

  it('forwards the selected emoji to the onEmojiSelected callback', () => {
    const onEmojiSelected = jest.fn();
    const { UNSAFE_root } = render(<HabitEmojiPicker onEmojiSelected={onEmojiSelected} />);
    const selector = UNSAFE_root.findByType('EmojiSelector');

    selector.props.onEmojiSelected('\u{1F600}');

    expect(onEmojiSelected).toHaveBeenCalledWith('\u{1F600}');
  });
});
