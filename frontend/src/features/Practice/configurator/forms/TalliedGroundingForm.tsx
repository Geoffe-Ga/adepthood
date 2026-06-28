import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import type { TalliedCategory, TalliedGroundingConfig } from '../../engine/types';

import { LabeledRow, NumberStepper, TextField } from './shared';

import { BORDER_RADIUS, SPACING, colors } from '@/design/tokens';

interface Props {
  value: TalliedGroundingConfig;
  onChange: (next: TalliedGroundingConfig) => void;
}

const ROUNDS_MIN = 1;
const ROUNDS_MAX = 10;
const TARGET_MIN = 1;
const TARGET_MAX = 20;
const LABEL_MAX = 60;

// Monotonic source of new category keys. The key is the machine id the engine
// records in session metadata, so it is generated once and never derived from
// the array position (stable-key guidance, audit section 5.2).
let nextCategoryKey = 0;

interface CategoryRowProps {
  category: TalliedCategory;
  index: number;
  onChange: (_patch: Partial<TalliedCategory>) => void;
  onRemove: () => void;
}

const CategoryRow = ({ category, index, onChange, onRemove }: CategoryRowProps) => (
  <View style={localStyles.card} testID={`tallied-category-${index}`}>
    <TextField
      value={category.label}
      onChange={(label) => onChange({ label })}
      placeholder="What to find (e.g. red things)"
      maxLength={LABEL_MAX}
      testID={`tallied-category-${index}-label`}
    />
    <LabeledRow label="How many to find">
      <NumberStepper
        value={category.target_count}
        onChange={(target_count) => onChange({ target_count })}
        step={1}
        min={TARGET_MIN}
        max={TARGET_MAX}
        testID={`tallied-category-${index}-count`}
      />
    </LabeledRow>
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={`Remove category ${index + 1}`}
      onPress={onRemove}
      style={localStyles.removeButton}
      testID={`tallied-category-${index}-remove`}
    >
      <Text style={localStyles.removeButtonText}>Remove</Text>
    </TouchableOpacity>
  </View>
);

const TalliedGroundingForm = ({ value, onChange }: Props): React.JSX.Element => {
  const setCategory = (index: number, patch: Partial<TalliedCategory>) => {
    const categories = value.categories.map((c, i) => (i === index ? { ...c, ...patch } : c));
    onChange({ ...value, categories });
  };
  const removeCategory = (index: number) =>
    onChange({ ...value, categories: value.categories.filter((_, i) => i !== index) });
  const addCategory = () => {
    // Underscore, not hyphen: the key must match TALLIED_KEY_PATTERN
    // (^[a-z][a-z0-9_]*$) or validateModeConfig rejects the new row.
    const key = `category_${(nextCategoryKey += 1)}`;
    const next: TalliedCategory = { key, label: '', target_count: 1 };
    onChange({ ...value, categories: [...value.categories, next] });
  };
  return (
    <View testID="tallied-grounding-form">
      <LabeledRow label="Rounds">
        <NumberStepper
          value={value.rounds}
          onChange={(rounds) => onChange({ ...value, rounds })}
          step={1}
          min={ROUNDS_MIN}
          max={ROUNDS_MAX}
          testID="tallied-rounds"
        />
      </LabeledRow>
      {value.categories.map((category, index) => (
        <CategoryRow
          key={category.key}
          category={category}
          index={index}
          onChange={(patch) => setCategory(index, patch)}
          onRemove={() => removeCategory(index)}
        />
      ))}
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Add category"
        onPress={addCategory}
        style={localStyles.addButton}
        testID="tallied-add-category"
      >
        <Text style={localStyles.addButtonText}>+ Add category</Text>
      </TouchableOpacity>
    </View>
  );
};

const localStyles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.sm,
    marginBottom: SPACING.sm,
  },
  addButton: { paddingVertical: SPACING.sm },
  addButtonText: { color: colors.primary, fontWeight: '600' },
  removeButton: { paddingVertical: SPACING.xs },
  removeButtonText: { color: colors.danger },
});

export default TalliedGroundingForm;
