import React from 'react';
import EmojiPicker, { type EmojiType } from 'rn-emoji-keyboard';

interface HabitEmojiPickerProps {
  visible: boolean;
  onSelect: (_emoji: string) => void;
  onClose: () => void;
}

/** Shared, self-presenting Habits emoji picker backed by rn-emoji-keyboard. */
const HabitEmojiPicker = ({ visible, onSelect, onClose }: HabitEmojiPickerProps) => (
  <EmojiPicker
    open={visible}
    onClose={onClose}
    onEmojiSelected={(emoji: EmojiType) => onSelect(emoji.emoji)}
    enableSearchBar
  />
);

export default HabitEmojiPicker;
