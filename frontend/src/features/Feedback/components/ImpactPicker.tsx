import React from 'react';
import { Text, useWindowDimensions, View } from 'react-native';

import { FEEDBACK_IMPACT_LABELS } from '../feedbackCategories';
import { FEEDBACK_COMPOSER_COPY } from '../feedbackCopy';
import { FEEDBACK_TEST_IDS } from '../feedbackTestIds';

import { optionStyles } from './optionStyles';

import type { FeedbackImpact } from '@/api';
import { RadioGroup, RadioOption } from '@/components/RadioOption';
import { type as typeRamp } from '@/design/tokens';

interface ImpactPickerProps {
  choices: readonly FeedbackImpact[];
  selected: FeedbackImpact | null;
  onSelect: (impact: FeedbackImpact) => void;
  disabled: boolean;
  error?: string;
}

/** How much the reported thing cost -- asked only where it is a question. */
export function ImpactPicker({
  choices,
  selected,
  onSelect,
  disabled,
  error,
}: ImpactPickerProps): React.JSX.Element | null {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  if (choices.length === 0) return null;
  return (
    <View style={optionStyles.section}>
      <Text allowFontScaling style={[t.label, optionStyles.prompt]}>
        {FEEDBACK_COMPOSER_COPY.impactPrompt}
      </Text>
      <RadioGroup
        style={optionStyles.group}
        accessibilityLabel={FEEDBACK_COMPOSER_COPY.impactPrompt}
      >
        {choices.map((impact) => (
          <RadioOption
            key={impact}
            label={FEEDBACK_IMPACT_LABELS[impact]}
            selected={selected === impact}
            disabled={disabled}
            onPress={() => onSelect(impact)}
            testID={FEEDBACK_TEST_IDS.impactOption(impact)}
            style={optionStyles.option}
            selectedStyle={optionStyles.optionSelected}
            labelStyle={optionStyles.label}
            selectedLabelStyle={optionStyles.labelSelected}
          />
        ))}
      </RadioGroup>
      {error === undefined ? null : (
        <Text
          allowFontScaling
          nativeID={FEEDBACK_TEST_IDS.impactError}
          testID={FEEDBACK_TEST_IDS.impactError}
          accessibilityLiveRegion="polite"
          style={[t.caption, optionStyles.error]}
        >
          {error}
        </Text>
      )}
    </View>
  );
}
