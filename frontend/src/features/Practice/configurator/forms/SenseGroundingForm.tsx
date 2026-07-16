import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import type { SenseGroundingConfig, SensePrompt } from '../../engine/types';
import { PROMPT_LABEL_MAX } from '../../engine/validation';

import GroundingDropdown from './GroundingDropdown';
import { useStableRowKeys } from './rowKeys';
import { AddRowButton, TextField } from './shared';

import { BORDER_RADIUS, SPACING, editorialType, ink, surface } from '@/design/tokens';

interface Props {
  value: SenseGroundingConfig;
  onChange: (next: SenseGroundingConfig) => void;
}

interface PromptRowsApi {
  keyAt: (_index: number) => string;
  setPrompt: (_index: number, _patch: Partial<SensePrompt>) => void;
  move: (_index: number, _direction: -1 | 1) => void;
  remove: (_index: number) => void;
  append: () => void;
}

/** Owns the prompt list, delegating transient stable row keys to the shared hook. */
function usePromptRows(
  value: SenseGroundingConfig,
  onChange: (next: SenseGroundingConfig) => void,
): PromptRowsApi {
  const rows = useStableRowKeys('prompt', value.prompts.length);

  const setPrompt = (index: number, patch: Partial<SensePrompt>) => {
    const next = value.prompts.map((prompt, i) => (i === index ? { ...prompt, ...patch } : prompt));
    onChange({ ...value, prompts: next });
  };
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    const current = value.prompts[index];
    const swapWith = value.prompts[target];
    if (current === undefined || swapWith === undefined) return;
    const next = value.prompts.slice();
    next[index] = swapWith;
    next[target] = current;
    rows.swap(index, target);
    onChange({ ...value, prompts: next });
  };
  const remove = (index: number) => {
    rows.remove(index);
    onChange({ ...value, prompts: value.prompts.filter((_, i) => i !== index) });
  };
  const append = () => {
    rows.append();
    onChange({ ...value, prompts: [...value.prompts, { sense: 'sight', label: '' }] });
  };
  return { keyAt: rows.keyAt, setPrompt, move, remove, append };
}

const SenseGroundingForm = ({ value, onChange }: Props): React.JSX.Element => {
  const { keyAt, setPrompt, move, remove, append } = usePromptRows(value, onChange);
  return (
    <View testID="sense-grounding-form">
      {value.prompts.map((prompt, index) => (
        <PromptRow
          key={keyAt(index)}
          prompt={prompt}
          index={index}
          last={index === value.prompts.length - 1}
          onChange={(patch) => setPrompt(index, patch)}
          onMove={(direction) => move(index, direction)}
          onRemove={() => remove(index)}
        />
      ))}
      <AddRowButton
        noun="prompt"
        onPress={append}
        variant="filled"
        style={localStyles.addButton}
        testID="sense-grounding-add"
      />
    </View>
  );
};

interface PromptRowProps {
  prompt: SensePrompt;
  index: number;
  last: boolean;
  onChange: (patch: Partial<SensePrompt>) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}

const PromptRow = ({
  prompt,
  index,
  last,
  onChange,
  onMove,
  onRemove,
}: PromptRowProps): React.JSX.Element => (
  <View style={localStyles.promptCard} testID={`sense-prompt-${index}`}>
    <GroundingDropdown index={index} value={prompt} onChange={onChange} />
    <TextField
      value={prompt.label}
      onChange={(label) => onChange({ label })}
      placeholder="What do you notice?"
      maxLength={PROMPT_LABEL_MAX}
      testID={`sense-prompt-${index}-label`}
    />
    <View style={localStyles.actionsRow}>
      <SmallButton
        label="↑"
        onPress={() => onMove(-1)}
        disabled={index === 0}
        testID={`sense-prompt-${index}-up`}
      />
      <SmallButton
        label="↓"
        onPress={() => onMove(1)}
        disabled={last}
        testID={`sense-prompt-${index}-down`}
      />
      <SmallButton label="Remove" onPress={onRemove} testID={`sense-prompt-${index}-remove`} />
    </View>
  </View>
);

interface SmallButtonProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID: string;
}

const SmallButton = ({
  label,
  onPress,
  disabled = false,
  testID,
}: SmallButtonProps): React.JSX.Element => (
  <TouchableOpacity
    accessibilityRole="button"
    accessibilityLabel={label}
    accessibilityState={{ disabled }}
    onPress={disabled ? undefined : onPress}
    style={[localStyles.smallButton, disabled && localStyles.disabled]}
    testID={testID}
  >
    <Text style={localStyles.smallButtonText}>{label}</Text>
  </TouchableOpacity>
);

const localStyles = StyleSheet.create({
  promptCard: {
    padding: SPACING.sm,
    backgroundColor: surface.raised,
    borderRadius: BORDER_RADIUS.md,
    marginBottom: SPACING.sm,
    gap: SPACING.xs,
  },
  actionsRow: { flexDirection: 'row', gap: SPACING.xs, marginTop: SPACING.xs },
  smallButton: {
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: surface.sunken,
    minHeight: 32,
  },
  smallButtonText: { ...editorialType.action, color: ink.primary },
  disabled: { opacity: 0.4 },
  addButton: { marginTop: SPACING.sm },
});

export default SenseGroundingForm;
