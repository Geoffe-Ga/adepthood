import React from 'react';
import { View } from 'react-native';

import type { MeditationTimerConfig, MetronomeConfig } from '../../engine/types';
import { BPM_MAX, BPM_MIN } from '../../engine/validation';

import MeditationTimerForm from './MeditationTimerForm';
import { LabeledRow, NumberStepper } from './shared';

interface Props {
  value: MetronomeConfig;
  onChange: (next: MetronomeConfig) => void;
}

const MetronomeForm = ({ value, onChange }: Props): React.JSX.Element => {
  const setBpm = (bpm: number) => onChange({ ...value, bpm });
  const setTimer = (timer: MeditationTimerConfig) => onChange({ ...value, timer });
  return (
    <View testID="metronome-form">
      <LabeledRow label="BPM" testID="metronome-bpm-row">
        <NumberStepper
          value={value.bpm}
          onChange={setBpm}
          step={1}
          bigStep={5}
          min={BPM_MIN}
          max={BPM_MAX}
          testID="metronome-bpm"
        />
      </LabeledRow>
      <MeditationTimerForm value={value.timer} onChange={setTimer} idPrefix="metronome-timer" />
    </View>
  );
};

export default MetronomeForm;
