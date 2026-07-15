import React from 'react';
import { View } from 'react-native';

import type { RandomIntervalBellConfig } from '../../engine/types';

import {
  BellToneRow,
  CollapsibleSection,
  DurationRow,
  LabeledRow,
  NumericField,
  ToggleRow,
} from './shared';

interface Props {
  value: RandomIntervalBellConfig;
  onChange: (next: RandomIntervalBellConfig) => void;
}

/**
 * Configurator form for the `random_interval_bell` mode. Core fields are
 * always visible; the rarer options live behind an "Advanced" toggle so
 * the form stays compact as the mode catalogue grows.
 */
const RandomIntervalBellForm = ({ value, onChange }: Props): React.JSX.Element => (
  <View testID="random-interval-bell-form">
    <DurationRow
      value={value.duration_minutes}
      onChange={(duration_minutes) => onChange({ ...value, duration_minutes })}
      testID="random-interval-bell-duration"
    />
    <LabeledRow label="Min interval (seconds)">
      <NumericField
        value={value.min_interval_seconds}
        onChange={(next) => onChange({ ...value, min_interval_seconds: next ?? 0 })}
        testID="random-interval-bell-min"
      />
    </LabeledRow>
    <LabeledRow label="Max interval (seconds)">
      <NumericField
        value={value.max_interval_seconds}
        onChange={(next) => onChange({ ...value, max_interval_seconds: next ?? 0 })}
        testID="random-interval-bell-max"
      />
    </LabeledRow>
    <BellToneRow value={value} onChange={onChange} testIDPrefix="random-interval-bell" />
    <CollapsibleSection testIDBase="random-interval-bell-advanced">
      <AdvancedFields value={value} onChange={onChange} />
    </CollapsibleSection>
  </View>
);

const AdvancedFields = ({ value, onChange }: Props): React.JSX.Element => (
  <View testID="random-interval-bell-advanced-fields">
    <LabeledRow label="Max bells (leave blank for no cap)">
      <NumericField
        value={value.max_bells ?? null}
        onChange={(next) => onChange({ ...value, max_bells: next })}
        placeholder="none"
        allowNull
        testID="random-interval-bell-max-bells"
      />
    </LabeledRow>
    <ToggleRow
      label="Start bell"
      value={value.start_bell ?? true}
      onChange={(start_bell) => onChange({ ...value, start_bell })}
      testID="random-interval-bell-start-bell"
    />
    <ToggleRow
      label="End bell"
      value={value.end_bell ?? true}
      onChange={(end_bell) => onChange({ ...value, end_bell })}
      testID="random-interval-bell-end-bell"
    />
  </View>
);

export default RandomIntervalBellForm;
