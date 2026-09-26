import React from 'react';
import { Text, useWindowDimensions } from 'react-native';

import { FEEDBACK_CATEGORY_CONFIG, FEEDBACK_CATEGORY_ORDER } from '../feedbackCategories';
import { FEEDBACK_COMPOSER_COPY } from '../feedbackCopy';
import { FEEDBACK_TEST_IDS } from '../feedbackTestIds';

import { optionStyles } from './optionStyles';

import type { FeedbackCategory } from '@/api';
import { RadioGroup, RadioOption } from '@/components/RadioOption';
import { type as typeRamp } from '@/design/tokens';

interface CategoryStepProps {
  selected: FeedbackCategory | null;
  onSelect: (category: FeedbackCategory) => void;
  disabled: boolean;
}

interface CategoryChoiceProps {
  category: FeedbackCategory;
  selected: boolean;
  disabled: boolean;
  onSelect: (category: FeedbackCategory) => void;
}

/**
 * One choice and its description. The description is visible text inside the
 * option -- it describes that option, so it sits in its box -- and the web's
 * `aria-describedby` target: react-native-web drops accessibilityHint, so the
 * hint alone reached nobody there.
 */
function CategoryChoice({
  category,
  selected,
  disabled,
  onSelect,
}: CategoryChoiceProps): React.JSX.Element {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  const config = FEEDBACK_CATEGORY_CONFIG[category];
  const descriptionId = FEEDBACK_TEST_IDS.categoryDescription(category);
  return (
    <RadioOption
      label={config.label}
      accessibilityHint={config.description}
      describedBy={descriptionId}
      hint={config.description}
      hintNativeID={descriptionId}
      hintStyle={[t.caption, optionStyles.description]}
      selected={selected}
      disabled={disabled}
      onPress={() => onSelect(category)}
      testID={FEEDBACK_TEST_IDS.categoryOption(category)}
      style={optionStyles.option}
      selectedStyle={optionStyles.optionSelected}
      labelStyle={optionStyles.label}
      selectedLabelStyle={optionStyles.labelSelected}
    />
  );
}

/** The first step: exactly four kinds of report, and nothing to type yet. */
export function CategoryStep({
  selected,
  onSelect,
  disabled,
}: CategoryStepProps): React.JSX.Element {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  return (
    <>
      <Text allowFontScaling style={[t.label, optionStyles.prompt]} accessibilityRole="header">
        {FEEDBACK_COMPOSER_COPY.categoryPrompt}
      </Text>
      <RadioGroup
        style={optionStyles.group}
        accessibilityLabel={FEEDBACK_COMPOSER_COPY.categoryPrompt}
      >
        {FEEDBACK_CATEGORY_ORDER.map((category) => (
          <CategoryChoice
            key={category}
            category={category}
            selected={selected === category}
            disabled={disabled}
            onSelect={onSelect}
          />
        ))}
      </RadioGroup>
    </>
  );
}
