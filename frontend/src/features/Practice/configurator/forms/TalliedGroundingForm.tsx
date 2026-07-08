import React from 'react';
import { View } from 'react-native';

import type { TalliedCategory, TalliedGroundingConfig } from '../../engine/types';
import {
  TALLIED_LABEL_MAX as LABEL_MAX,
  TALLIED_ROUNDS_MAX as ROUNDS_MAX,
  TALLIED_ROUNDS_MIN as ROUNDS_MIN,
  TALLIED_TARGET_MAX as TARGET_MAX,
  TALLIED_TARGET_MIN as TARGET_MIN,
} from '../../engine/validation';

import { makeRowKeyFactory } from './rowKeys';
import {
  AddRowButton,
  LabeledRow,
  NumberStepper,
  RemoveButton,
  RowCard,
  TextField,
} from './shared';

interface Props {
  value: TalliedGroundingConfig;
  onChange: (next: TalliedGroundingConfig) => void;
}

// New category keys are the machine id the engine records in session metadata,
// minted once and never derived from the array position. Underscore, not
// hyphen: the key must match TALLIED_KEY_PATTERN (^[a-z][a-z0-9_]*$) or
// validateModeConfig rejects it.
const nextCategoryKey = makeRowKeyFactory('category');

interface CategoryRowProps {
  category: TalliedCategory;
  index: number;
  onChange: (_patch: Partial<TalliedCategory>) => void;
  onRemove: () => void;
}

const CategoryRow = ({ category, index, onChange, onRemove }: CategoryRowProps) => (
  <RowCard testID={`tallied-category-${index}`}>
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
    <RemoveButton
      noun="category"
      index={index}
      onPress={onRemove}
      testID={`tallied-category-${index}-remove`}
    />
  </RowCard>
);

const TalliedGroundingForm = ({ value, onChange }: Props): React.JSX.Element => {
  const setCategory = (index: number, patch: Partial<TalliedCategory>) => {
    const categories = value.categories.map((c, i) => (i === index ? { ...c, ...patch } : c));
    onChange({ ...value, categories });
  };
  const removeCategory = (index: number) =>
    onChange({ ...value, categories: value.categories.filter((_, i) => i !== index) });
  const addCategory = () => {
    const next: TalliedCategory = { key: nextCategoryKey(), label: '', target_count: 1 };
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
      <AddRowButton noun="category" onPress={addCategory} testID="tallied-add-category" />
    </View>
  );
};

export default TalliedGroundingForm;
