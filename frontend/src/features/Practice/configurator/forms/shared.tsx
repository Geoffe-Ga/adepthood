import React, { useState } from 'react';
import { StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';

import type { IntervalBellTone } from '../../engine/types';

import { BORDER_RADIUS, SPACING, colors } from '@/design/tokens';

interface LabeledRowProps {
  label: string;
  testID?: string;
  children: React.ReactNode;
}

export const LabeledRow = ({ label, testID, children }: LabeledRowProps): React.JSX.Element => (
  <View style={formStyles.row} testID={testID}>
    <Text style={formStyles.label}>{label}</Text>
    <View style={formStyles.control}>{children}</View>
  </View>
);

interface NumberStepperProps {
  value: number;
  onChange: (next: number) => void;
  step: number;
  bigStep?: number;
  min: number;
  max: number;
  testID: string;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const NumberStepper = ({
  value,
  onChange,
  step,
  bigStep,
  min,
  max,
  testID,
}: NumberStepperProps): React.JSX.Element => {
  const adjust = (delta: number) => onChange(clamp(value + delta, min, max));
  return (
    <View style={formStyles.stepperRow} testID={testID}>
      {bigStep !== undefined && (
        <StepperButton
          label={`-${bigStep}`}
          onPress={() => adjust(-bigStep)}
          testID={`${testID}-minus-big`}
        />
      )}
      <StepperButton label={`-${step}`} onPress={() => adjust(-step)} testID={`${testID}-minus`} />
      <Text style={formStyles.stepperValue} testID={`${testID}-value`}>
        {value}
      </Text>
      <StepperButton label={`+${step}`} onPress={() => adjust(step)} testID={`${testID}-plus`} />
      {bigStep !== undefined && (
        <StepperButton
          label={`+${bigStep}`}
          onPress={() => adjust(bigStep)}
          testID={`${testID}-plus-big`}
        />
      )}
    </View>
  );
};

interface StepperButtonProps {
  label: string;
  onPress: () => void;
  testID: string;
}

const StepperButton = ({ label, onPress, testID }: StepperButtonProps): React.JSX.Element => (
  <TouchableOpacity
    accessibilityRole="button"
    accessibilityLabel={label}
    onPress={onPress}
    style={formStyles.stepperButton}
    testID={testID}
  >
    <Text style={formStyles.stepperButtonText}>{label}</Text>
  </TouchableOpacity>
);

interface NumericFieldProps {
  value: number | null;
  onChange: (next: number | null) => void;
  placeholder?: string;
  allowNull?: boolean;
  testID: string;
}

export const NumericField = ({
  value,
  onChange,
  placeholder,
  allowNull = false,
  testID,
}: NumericFieldProps): React.JSX.Element => (
  <TextInput
    style={formStyles.input}
    value={value === null ? '' : String(value)}
    onChangeText={(text) => {
      if (text.trim() === '') {
        onChange(allowNull ? null : 0);
        return;
      }
      const parsed = Number(text);
      if (Number.isFinite(parsed)) onChange(parsed);
    }}
    keyboardType="numeric"
    placeholder={placeholder}
    testID={testID}
  />
);

interface ToggleRowProps {
  label: string;
  value: boolean;
  onChange: (next: boolean) => void;
  testID: string;
}

export const ToggleRow = ({
  label,
  value,
  onChange,
  testID,
}: ToggleRowProps): React.JSX.Element => (
  <View style={formStyles.row} testID={`${testID}-row`}>
    <Text style={formStyles.label}>{label}</Text>
    <Switch value={value} onValueChange={onChange} testID={testID} />
  </View>
);

interface TextFieldProps {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  testID: string;
  maxLength?: number;
}

export const TextField = ({
  value,
  onChange,
  placeholder,
  testID,
  maxLength,
}: TextFieldProps): React.JSX.Element => (
  <TextInput
    style={formStyles.input}
    value={value}
    onChangeText={onChange}
    placeholder={placeholder}
    maxLength={maxLength}
    testID={testID}
  />
);

interface ChipProps {
  label: string;
  active: boolean;
  onPress: () => void;
  testID: string;
}

export const Chip = ({ label, active, onPress, testID }: ChipProps): React.JSX.Element => (
  <TouchableOpacity
    accessibilityRole="button"
    accessibilityLabel={label}
    onPress={onPress}
    style={[formStyles.chip, active && formStyles.chipActive]}
    testID={testID}
  >
    <Text style={[formStyles.chipText, active && formStyles.chipTextActive]}>{label}</Text>
  </TouchableOpacity>
);

export const ErrorList = ({ errors }: { errors: readonly string[] }): React.JSX.Element | null => {
  if (errors.length === 0) return null;
  return (
    <View testID="configurator-errors" style={formStyles.errors}>
      {errors.map((message) => (
        <Text key={message} style={formStyles.errorText}>
          • {message}
        </Text>
      ))}
    </View>
  );
};

/** The bell tones every interval-bell mode offers. */
export const BELL_TONES: readonly IntervalBellTone[] = ['bowl', 'chime', 'gong'];

interface BellToneRowProps<T extends { bell_tone: IntervalBellTone }> {
  value: T;
  onChange: (_next: T) => void;
  /** testID stem, e.g. ``interval-bell`` → ``interval-bell-tone-bowl``. */
  testIDPrefix: string;
}

/** Tone picker shared by the interval-bell and random-interval-bell forms. */
export const BellToneRow = <T extends { bell_tone: IntervalBellTone }>({
  value,
  onChange,
  testIDPrefix,
}: BellToneRowProps<T>): React.JSX.Element => (
  <LabeledRow label="Bell tone">
    <View style={formStyles.toneRow}>
      {BELL_TONES.map((tone) => (
        <Chip
          key={tone}
          label={tone}
          active={value.bell_tone === tone}
          onPress={() => onChange({ ...value, bell_tone: tone })}
          testID={`${testIDPrefix}-tone-${tone}`}
        />
      ))}
    </View>
  </LabeledRow>
);

interface CollapsibleSectionProps {
  /** testID stem, e.g. ``card-meditation-advanced`` → ``…-advanced-toggle``. */
  testIDBase: string;
  label?: string;
  children: React.ReactNode;
}

/** "Advanced" disclosure shared across configurator forms. */
export const CollapsibleSection = ({
  testIDBase,
  label = 'Advanced',
  children,
}: CollapsibleSectionProps): React.JSX.Element => {
  const [open, setOpen] = useState(false);
  return (
    <View testID={testIDBase}>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={`${label} settings`}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((prev) => !prev)}
        style={formStyles.advancedToggle}
        testID={`${testIDBase}-toggle`}
      >
        <Text style={formStyles.advancedToggleText}>{`${open ? '▾' : '▸'} ${label}`}</Text>
      </TouchableOpacity>
      {open && children}
    </View>
  );
};

const formStyles = StyleSheet.create({
  toneRow: { flexDirection: 'row', gap: SPACING.xs, flexWrap: 'wrap' },
  advancedToggle: { paddingVertical: SPACING.md, marginTop: SPACING.sm },
  advancedToggleText: { fontSize: 14, fontWeight: '600', color: colors.text.primary },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: SPACING.sm,
    gap: SPACING.md,
  },
  label: {
    color: colors.text.primary,
    fontSize: 14,
    fontWeight: '500',
    flexShrink: 1,
  },
  control: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  stepperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
  },
  stepperValue: {
    minWidth: 48,
    textAlign: 'center',
    fontSize: 16,
    color: colors.text.primary,
    fontVariant: ['tabular-nums'],
  },
  stepperButton: {
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    borderRadius: BORDER_RADIUS.sm,
    backgroundColor: colors.background.accent,
    minWidth: 36,
    alignItems: 'center',
  },
  stepperButtonText: {
    color: colors.text.primary,
    fontSize: 14,
    fontWeight: '600',
  },
  input: {
    minWidth: 80,
    borderWidth: 1,
    borderColor: colors.background.accent,
    borderRadius: BORDER_RADIUS.sm,
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    color: colors.text.primary,
    fontSize: 14,
  },
  chip: {
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.xl,
    borderWidth: 1,
    borderColor: colors.background.accent,
    backgroundColor: colors.background.card,
  },
  chipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  chipText: {
    color: colors.text.secondaryAccessible,
    fontSize: 13,
    fontWeight: '500',
  },
  chipTextActive: {
    color: colors.text.light,
  },
  errors: {
    backgroundColor: colors.background.card,
    borderLeftColor: colors.danger,
    borderLeftWidth: 3,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    marginTop: SPACING.sm,
  },
  errorText: {
    color: colors.danger,
    fontSize: 13,
    marginVertical: 2,
  },
});

export { formStyles };
