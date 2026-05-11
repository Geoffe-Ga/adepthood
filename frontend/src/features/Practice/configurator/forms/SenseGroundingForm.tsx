import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import type { SenseGroundingConfig, SenseKind, SensePrompt } from '../../engine/types';
import { ALLOWED_SENSES, PROMPT_LABEL_MAX } from '../../engine/validation';

import { Chip, TextField } from './shared';

import { BORDER_RADIUS, SPACING, colors } from '@/design/tokens';

interface Props {
  value: SenseGroundingConfig;
  onChange: (next: SenseGroundingConfig) => void;
}

const SenseGroundingForm = ({ value, onChange }: Props): React.JSX.Element => {
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
    onChange({ ...value, prompts: next });
  };
  const remove = (index: number) => {
    onChange({ ...value, prompts: value.prompts.filter((_, i) => i !== index) });
  };
  const append = () =>
    onChange({ ...value, prompts: [...value.prompts, { sense: 'sight', label: '' }] });
  return (
    <View testID="sense-grounding-form">
      {value.prompts.map((prompt, index) => (
        <PromptRow
          key={index}
          prompt={prompt}
          index={index}
          last={index === value.prompts.length - 1}
          onChange={(patch) => setPrompt(index, patch)}
          onMove={(direction) => move(index, direction)}
          onRemove={() => remove(index)}
        />
      ))}
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Add prompt"
        onPress={append}
        style={localStyles.addButton}
        testID="sense-grounding-add"
      >
        <Text style={localStyles.addButtonText}>+ Add prompt</Text>
      </TouchableOpacity>
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
    <View style={localStyles.senseRow}>
      {ALLOWED_SENSES.map((sense) => (
        <Chip
          key={sense}
          label={sense}
          active={prompt.sense === sense}
          onPress={() => onChange({ sense: sense satisfies SenseKind })}
          testID={`sense-prompt-${index}-${sense}`}
        />
      ))}
    </View>
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
    backgroundColor: colors.background.card,
    borderRadius: BORDER_RADIUS.md,
    marginBottom: SPACING.sm,
    gap: SPACING.xs,
  },
  senseRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.xs },
  actionsRow: { flexDirection: 'row', gap: SPACING.xs, marginTop: SPACING.xs },
  smallButton: {
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    borderRadius: BORDER_RADIUS.sm,
    backgroundColor: colors.background.accent,
    minHeight: 32,
  },
  smallButtonText: { color: colors.text.primary, fontSize: 13, fontWeight: '500' },
  disabled: { opacity: 0.4 },
  addButton: {
    paddingVertical: SPACING.sm,
    borderRadius: BORDER_RADIUS.sm,
    backgroundColor: colors.background.accent,
    alignItems: 'center',
    marginTop: SPACING.sm,
  },
  addButtonText: { color: colors.text.primary, fontWeight: '600', fontSize: 14 },
});

export default SenseGroundingForm;
