import React from 'react';
import { View } from 'react-native';

import type { TarotConfig } from '../../engine/types';
import { DEFAULT_TAROT_MINUTES } from '../../engine/types';

import { HideTimerToggle, LabeledRow, NumericField } from './shared';

interface Props {
  value: TarotConfig;
  onChange: (next: TarotConfig) => void;
}

const TarotForm = ({ value, onChange }: Props): React.JSX.Element => {
  const setMinutes = (per_card_minutes: number | null) =>
    onChange({ ...value, per_card_minutes: per_card_minutes ?? DEFAULT_TAROT_MINUTES });
  return (
    <View testID="tarot-form">
      <LabeledRow label="Per-card minutes">
        <NumericField
          value={value.per_card_minutes ?? DEFAULT_TAROT_MINUTES}
          onChange={setMinutes}
          allowNull
          testID="tarot-per-card"
        />
      </LabeledRow>
      <HideTimerToggle value={value} onChange={onChange} testID="tarot-hide-timer" />
    </View>
  );
};

export default TarotForm;
