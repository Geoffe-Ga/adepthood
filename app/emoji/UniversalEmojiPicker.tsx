import data from '@emoji-mart/data';
import PickerWeb from '@emoji-mart/react';
import PickerNative from 'emoji-mart-native';
import React from 'react';
import { Button, Modal, Platform, View } from 'react-native';

import type { EmojiSelectionPayload } from '../types/emoji';
import { useEmojiPreferences } from './emoji-prefs';

export interface UniversalEmojiPickerProps {
  visible: boolean;
  onClose: () => void;
  onSelect: (selection: EmojiSelectionPayload) => void;
  anchorRect?: { x: number; y: number };
  theme?: 'light' | 'dark' | 'auto';
}

const WEB_PICKER_WIDTH = 320;
const WEB_PICKER_MAX_HEIGHT = 300;
const WEB_EMOJI_SIZE = 24;
const WEB_PER_LINE = 8;

export const UniversalEmojiPicker: React.FC<UniversalEmojiPickerProps> = ({
  visible,
  onClose,
  onSelect,
  theme = 'auto',
}) => {
  const { recents, clearRecents, preferredSkinTone, pushRecent } = useEmojiPreferences();

  interface PickerEmoji {
    native: string;
    unified: string;
    shortcodes?: string;
    skin?: number;
  }

  const handleSelect = (emoji: PickerEmoji) => {
    const selection: EmojiSelectionPayload = {
      emoji: emoji.native,
      unified: emoji.unified,
      shortcodes: emoji.shortcodes ? emoji.shortcodes.split(',') : [],
      skinToneApplied: emoji.skin ?? undefined,
    };
    pushRecent(selection.unified);
    onSelect(selection);
  };

  if (Platform.OS === 'web') {
    if (!visible) return null;
    return (
      <View style={{ position: 'absolute', zIndex: 10 }}>
        <PickerWeb
          data={data}
          onEmojiSelect={handleSelect}
          theme={theme}
          onClickOutside={onClose}
          skinTone={preferredSkinTone}
          emojiSize={WEB_EMOJI_SIZE}
          perLine={WEB_PER_LINE}
          dynamicWidth={false}
          previewPosition="none"
          style={{
            width: WEB_PICKER_WIDTH,
            maxHeight: WEB_PICKER_MAX_HEIGHT,
            overflowY: 'auto',
            fontSize: WEB_EMOJI_SIZE,
          }}
          categories={[
            'frequent',
            'people',
            'nature',
            'foods',
            'activity',
            'places',
            'objects',
            'symbols',
            'flags',
          ]}
          custom={recents.map((u) => ({ id: u, name: u }))}
        />
        {recents.length > 0 && <Button title="Clear recents" onPress={clearRecents} />}
      </View>
    );
  }

  return (
    <Modal visible={visible} onRequestClose={onClose} animationType="slide">
      <PickerNative
        data={data}
        onEmojiSelect={handleSelect}
        theme={theme}
        skinTone={preferredSkinTone}
        skinTonePosition="preview"
      />
      {recents.length > 0 && <Button title="Clear recents" onPress={clearRecents} />}
    </Modal>
  );
};
