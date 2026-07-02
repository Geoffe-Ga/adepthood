import React from 'react';
import EmojiSelector from 'react-native-emoji-selector';

const EMOJI_COLUMNS = 6;
const EMOJI_SIZE = 28;
const EMOJI_SEARCH_PLACEHOLDER = 'Search emoji...';

interface HabitEmojiPickerProps {
  onEmojiSelected: (_emoji: string) => void;
}

/**
 * Shared Habits emoji picker. Wraps `react-native-emoji-selector` with the one
 * canonical search-bar configuration so every Habits call site renders the same
 * placeholder, column count, and glyph size.
 */
const HabitEmojiPicker = ({ onEmojiSelected }: HabitEmojiPickerProps) => (
  <EmojiSelector
    onEmojiSelected={onEmojiSelected}
    showSearchBar
    columns={EMOJI_COLUMNS}
    emojiSize={EMOJI_SIZE}
    placeholder={EMOJI_SEARCH_PLACEHOLDER}
  />
);

export default HabitEmojiPicker;
