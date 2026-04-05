declare module 'react-native-emoji-selector' {
  import type { Component } from 'react';

  interface EmojiSelectorProps {
    onEmojiSelected: (emoji: string) => void;
    showSearchBar?: boolean;
    columns?: number;
    emojiSize?: number;
    placeholder?: string;
  }

  export default class EmojiSelector extends Component<EmojiSelectorProps> {}
}
