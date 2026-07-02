// Jest mock for ``rn-emoji-keyboard``: the real ``EmojiPicker`` renders a
// native bottom-sheet Modal that jsdom/RN-test-renderer cannot host. Exposes
// a single deterministic emoji tile so callers can assert the wrapper
// extracts ``e.emoji`` correctly.
const React = require('react');
const { View, Pressable } = require('react-native');

const MOCK_EMOJI = '\u{1F389}';

const EmojiPicker = (props) => {
  if (!props.open) return null;

  return React.createElement(
    View,
    { testID: 'emoji-picker' },
    React.createElement(Pressable, {
      testID: 'emoji-picker-select',
      onPress: () => props.onEmojiSelected({ emoji: MOCK_EMOJI }),
    }),
    React.createElement(Pressable, {
      testID: 'emoji-picker-close',
      onPress: props.onClose,
    }),
  );
};

module.exports = EmojiPicker;
module.exports.default = EmojiPicker;
