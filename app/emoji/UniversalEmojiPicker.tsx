/* eslint-disable import/order */
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
  // eslint-disable-next-line no-unused-vars
  onSelect: (_: EmojiSelectionPayload) => void;
  anchorRect?: { x: number; y: number };
  theme?: 'light' | 'dark' | 'auto';
}

export const UniversalEmojiPicker: React.FC<UniversalEmojiPickerProps> = ({
  visible,
  onClose,
  onSelect,
  theme = 'auto',
}) => {
  const { recents, clearRecents, preferredSkinTone, pushRecent } = useEmojiPreferences();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleSelect = (emoji: any) => {
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
