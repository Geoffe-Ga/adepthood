import * as Haptics from 'expo-haptics';
import React, { useRef, useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';

import type { EmojiSelectionPayload } from '../types/emoji';

import { UniversalEmojiPicker } from './UniversalEmojiPicker';

export interface UniversalEmojiButtonProps {
  value: string;
  onChange: (selection: EmojiSelectionPayload) => void;
  size?: number;
  disabled?: boolean;
}

export const UniversalEmojiButton: React.FC<UniversalEmojiButtonProps> = ({
  value,
  onChange,
  size = 32,
  disabled,
}) => {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<View>(null);

  const handlePress = () => {
    if (disabled) return;
    if (Haptics?.impactAsync) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
    setOpen(true);
  };

  return (
    <View ref={anchorRef}>
      <TouchableOpacity accessibilityRole="button" onPress={handlePress} disabled={disabled}>
        <Text style={{ fontSize: size }}>{value}</Text>
      </TouchableOpacity>
      <UniversalEmojiPicker
        visible={open}
        onClose={() => setOpen(false)}
        onSelect={(sel) => {
          setOpen(false);
          onChange(sel);
        }}
        anchorRect={undefined}
      />
    </View>
  );
};
