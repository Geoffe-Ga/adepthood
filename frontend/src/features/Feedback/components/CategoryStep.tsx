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
        {FEEDBACK_CATEGORY_ORDER.map((category) => {
          const config = FEEDBACK_CATEGORY_CONFIG[category];
          return (
            <RadioOption
              key={category}
              label={config.label}
              accessibilityHint={config.description}
              selected={selected === category}
              disabled={disabled}
              onPress={() => onSelect(category)}
              testID={FEEDBACK_TEST_IDS.categoryOption(category)}
              style={optionStyles.option}
              selectedStyle={optionStyles.optionSelected}
              labelStyle={optionStyles.label}
              selectedLabelStyle={optionStyles.labelSelected}
            />
          );
        })}
      </RadioGroup>
    </>
  );
}
