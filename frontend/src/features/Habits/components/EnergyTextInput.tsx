import React, { useEffect, useState } from 'react';
import { TextInput, type StyleProp, type TextStyle } from 'react-native';

import { parseEnergyValue } from './parseEnergyValue';

interface EnergyTextInputProps {
  value: number;
  onCommit: (_value: number) => void;
  style?: StyleProp<TextStyle>;
  testID?: string;
}

// Local string buffer so mid-edit states ('', '-', '58') aren't snapped
// back to the last committed integer on every keystroke.
export const EnergyTextInput = ({ value, onCommit, style, testID }: EnergyTextInputProps) => {
  const [text, setText] = useState<string>(value.toString());

  // External value changes (e.g. modal reset, opening for a different habit)
  // override the buffer. Don't drive ``value`` from a timer or auto-save loop
  // while the user is typing — it will stomp their in-progress edit.
  useEffect(() => {
    setText(value.toString());
  }, [value]);

  const handleChangeText = (next: string) => {
    setText(next);
    const parsed = parseEnergyValue(next);
    if (parsed !== null) onCommit(parsed);
  };

  const handleBlur = () => {
    if (parseEnergyValue(text) === null) {
      setText(value.toString());
    }
  };

  return (
    <TextInput
      testID={testID}
      style={style}
      value={text}
      onChangeText={handleChangeText}
      onBlur={handleBlur}
      keyboardType="numbers-and-punctuation"
    />
  );
};
