import React from 'react';
import { View } from 'react-native';

import type { MeditationTimerConfig } from '../../engine/types';

import { DurationRow, ToggleRow } from './shared';

interface Props {
  value: MeditationTimerConfig;
  onChange: (next: MeditationTimerConfig) => void;
  /** Optional override so the field's testIDs are unique when embedded. */
  idPrefix?: string;
}

const MeditationTimerForm = ({
  value,
  onChange,
  idPrefix = 'meditation-timer',
}: Props): React.JSX.Element => {
  const update = (patch: Partial<MeditationTimerConfig>) => onChange({ ...value, ...patch });
  return (
    <View testID={`${idPrefix}-form`}>
      <DurationRow
        value={value.duration_minutes}
        onChange={(duration_minutes) => update({ duration_minutes })}
        testID={`${idPrefix}-duration`}
      />
      <ToggleRow
        label="Start bell"
        value={value.start_bell ?? true}
        onChange={(start_bell) => update({ start_bell })}
        testID={`${idPrefix}-start-bell`}
      />
      <ToggleRow
        label="Halfway bell"
        value={value.halfway_bell ?? false}
        onChange={(halfway_bell) => update({ halfway_bell })}
        testID={`${idPrefix}-halfway-bell`}
      />
      <ToggleRow
        label="End bell"
        value={value.end_bell ?? true}
        onChange={(end_bell) => update({ end_bell })}
        testID={`${idPrefix}-end-bell`}
      />
    </View>
  );
};

export default MeditationTimerForm;
