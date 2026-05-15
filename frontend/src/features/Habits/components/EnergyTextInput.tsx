import React, { useEffect, useState } from 'react';
import { TextInput, type StyleProp, type TextStyle } from 'react-native';

import { parseEnergyValue } from './parseEnergyValue';

interface EnergyTextInputProps {
  value: number;
  onCommit: (_value: number) => void;
  style?: StyleProp<TextStyle>;
  testID?: string;
}

/**
 * Controlled-but-tolerant numeric input for the cost / return fields.
 *
 * The previous wiring fed the parsed integer straight back into the
 * ``TextInput`` ``value`` prop, so any keystroke that produced an
 * intermediate string (``""`` after a backspace, a lone ``"-"`` while
 * typing ``"-5"``, or ``"58"`` mid-edit toward ``"8"``) failed parsing,
 * left the numeric state untouched, and snapped the input back to its
 * prior value. On mobile this looked like the field was uneditable.
 *
 * The buffer here holds whatever the user has typed; the parsed integer
 * only escapes to ``onCommit`` when the buffer is a valid integer in
 * range. ``onBlur`` rolls the buffer back to the last committed value
 * so an invalid mid-edit doesn't strand a stale string on screen.
 */
export const EnergyTextInput = ({ value, onCommit, style, testID }: EnergyTextInputProps) => {
  const [text, setText] = useState<string>(value.toString());

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

export default EnergyTextInput;
