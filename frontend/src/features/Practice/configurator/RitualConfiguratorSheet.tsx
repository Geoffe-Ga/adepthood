import React, { useCallback, useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import type { ModeConfig } from '../engine/types';
import { validateModeConfig } from '../engine/validation';

import CountUpForm from './forms/CountUpForm';
import IntervalBellForm from './forms/IntervalBellForm';
import MeditationTimerForm from './forms/MeditationTimerForm';
import MetronomeForm from './forms/MetronomeForm';
import RepCounterForm from './forms/RepCounterForm';
import SenseGroundingForm from './forms/SenseGroundingForm';
import { ErrorList } from './forms/shared';
import TarotForm from './forms/TarotForm';

import { type UserPractice, type UserPracticeCustomize, userPractices } from '@/api';
import { formatApiError } from '@/api/errorMessages';
import { BORDER_RADIUS, SPACING, colors, shadows } from '@/design/tokens';

export interface RitualConfiguratorSheetProps {
  visible: boolean;
  userPracticeId: number;
  initialName: string;
  aspect?: string | null;
  initialConfig: ModeConfig;
  /** Override the API client; used by tests so they don't hit the network. */
  customize?: typeof userPractices.customize;
  onClose: () => void;
  onSaved?: (updated: UserPractice) => void;
}

/**
 * Bottom-sheet modal for editing the active practice's name and per-mode
 * config. The mode itself is **not** editable here -- replacing the
 * practice mode is a separate flow (ritual-10).
 */
const RitualConfiguratorSheet = (props: RitualConfiguratorSheetProps): React.JSX.Element => {
  const [name, setName] = useState(props.initialName);
  const [config, setConfig] = useState<ModeConfig>(props.initialConfig);
  const state = useSaveState();

  const dirty = useMemo(
    () => name !== props.initialName || !isShallowEqualConfig(config, props.initialConfig),
    [name, config, props.initialName, props.initialConfig],
  );
  const errors = useMemo(() => validateModeConfig(config), [config]);
  const canSave = dirty && errors.length === 0 && !state.submitting;

  return (
    <Modal visible={props.visible} transparent animationType="slide" onRequestClose={props.onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.overlay}
        testID="ritual-configurator-overlay"
      >
        <View style={styles.sheet} testID="ritual-configurator-sheet">
          <ConfiguratorHeader
            name={name}
            aspect={props.aspect ?? null}
            onNameChange={setName}
            onCancel={props.onClose}
            onSave={() => state.save(props, { name, config })}
            canSave={canSave}
          />
          <ScrollView style={styles.body} keyboardShouldPersistTaps="handled">
            <ConfiguratorBody config={config} onChange={setConfig} />
            <ErrorList errors={errors} />
            {state.apiError !== null && (
              <Text style={styles.apiError} testID="ritual-configurator-api-error">
                {state.apiError}
              </Text>
            )}
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Reset to default"
              onPress={() => state.reset(props)}
              style={styles.resetButton}
              testID="ritual-configurator-reset"
              disabled={state.submitting}
            >
              <Text style={styles.resetText}>Reset to default</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
};

interface HeaderProps {
  name: string;
  aspect: string | null;
  onNameChange: (next: string) => void;
  onCancel: () => void;
  onSave: () => void;
  canSave: boolean;
}

const ConfiguratorHeader = ({
  name,
  aspect,
  onNameChange,
  onCancel,
  onSave,
  canSave,
}: HeaderProps): React.JSX.Element => (
  <View style={styles.header}>
    <View style={styles.nameRow}>
      <TextInput
        style={styles.nameInput}
        value={name}
        onChangeText={onNameChange}
        placeholder="Practice name"
        testID="ritual-configurator-name"
      />
      {aspect !== null && aspect.length > 0 && (
        <View style={styles.aspectChip} testID="ritual-configurator-aspect">
          <Text style={styles.aspectText}>{aspect}</Text>
        </View>
      )}
    </View>
    <View style={styles.actionRow}>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Cancel"
        onPress={onCancel}
        style={styles.cancelButton}
        testID="ritual-configurator-cancel"
      >
        <Text style={styles.cancelText}>Cancel</Text>
      </TouchableOpacity>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Save"
        accessibilityState={{ disabled: !canSave }}
        onPress={canSave ? onSave : undefined}
        style={[styles.saveButton, !canSave && styles.disabledButton]}
        testID="ritual-configurator-save"
      >
        <Text style={styles.saveText}>Save</Text>
      </TouchableOpacity>
    </View>
  </View>
);

interface BodyProps {
  config: ModeConfig;
  onChange: (next: ModeConfig) => void;
}

const ConfiguratorBody = ({ config, onChange }: BodyProps): React.JSX.Element => {
  switch (config.mode) {
    case 'meditation_timer':
      return <MeditationTimerForm value={config} onChange={onChange} />;
    case 'count_up':
      return <CountUpForm value={config} onChange={onChange} />;
    case 'metronome':
      return <MetronomeForm value={config} onChange={onChange} />;
    case 'interval_bell':
      return <IntervalBellForm value={config} onChange={onChange} />;
    case 'rep_counter':
      return <RepCounterForm value={config} onChange={onChange} />;
    case 'sense_grounding':
      return <SenseGroundingForm value={config} onChange={onChange} />;
    case 'tarot':
      return <TarotForm value={config} onChange={onChange} />;
    default:
      return <UnknownModeNotice />;
  }
};

const UnknownModeNotice = (): React.JSX.Element => (
  <View testID="ritual-configurator-unknown">
    <Text style={styles.unknownText}>
      Configuration not yet available — long-press to replace this practice.
    </Text>
  </View>
);

interface SaveValues {
  name: string;
  config: ModeConfig;
}

interface SaveState {
  submitting: boolean;
  apiError: string | null;
  save: (props: RitualConfiguratorSheetProps, values: SaveValues) => Promise<void>;
  reset: (props: RitualConfiguratorSheetProps) => Promise<void>;
}

function useSaveState(): SaveState {
  const [submitting, setSubmitting] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);

  const run = useCallback(
    async (props: RitualConfiguratorSheetProps, payload: UserPracticeCustomize): Promise<void> => {
      setSubmitting(true);
      setApiError(null);
      try {
        const client = props.customize ?? userPractices.customize;
        const updated = await client(props.userPracticeId, payload);
        props.onSaved?.(updated);
        props.onClose();
      } catch (err: unknown) {
        setApiError(formatApiError(err, { fallback: 'Could not save practice.' }));
      } finally {
        setSubmitting(false);
      }
    },
    [],
  );

  const save = useCallback(
    (props: RitualConfiguratorSheetProps, values: SaveValues) =>
      run(props, {
        custom_name: values.name === props.initialName ? undefined : values.name,
        mode_config_override: values.config as unknown as Record<string, unknown>,
      }),
    [run],
  );

  const reset = useCallback(
    (props: RitualConfiguratorSheetProps) =>
      run(props, { custom_name: null, mode_config_override: null }),
    [run],
  );

  return { submitting, apiError, save, reset };
}

function isShallowEqualConfig(a: ModeConfig, b: ModeConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: colors.mystical.overlay,
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.background.primary,
    borderTopLeftRadius: BORDER_RADIUS.xl,
    borderTopRightRadius: BORDER_RADIUS.xl,
    maxHeight: '90%',
    ...shadows.large,
  },
  header: {
    paddingHorizontal: SPACING.lg,
    paddingTop: SPACING.lg,
    paddingBottom: SPACING.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.background.accent,
    gap: SPACING.sm,
  },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  nameInput: {
    flex: 1,
    fontSize: 18,
    fontWeight: '600',
    color: colors.text.primary,
    paddingVertical: SPACING.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.background.accent,
  },
  aspectChip: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: BORDER_RADIUS.lg,
    backgroundColor: colors.background.accent,
  },
  aspectText: { color: colors.text.primary, fontSize: 12, fontWeight: '500' },
  actionRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: SPACING.sm },
  cancelButton: {
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    borderRadius: BORDER_RADIUS.md,
  },
  cancelText: { color: colors.text.secondaryAccessible, fontSize: 14, fontWeight: '500' },
  saveButton: {
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: colors.primary,
  },
  disabledButton: { opacity: 0.4 },
  saveText: { color: colors.text.light, fontSize: 14, fontWeight: '600' },
  body: { padding: SPACING.lg },
  apiError: { color: colors.danger, fontSize: 13, marginTop: SPACING.sm },
  resetButton: {
    marginTop: SPACING.lg,
    paddingVertical: SPACING.sm,
    alignItems: 'center',
  },
  resetText: { color: colors.danger, fontSize: 13, fontWeight: '500' },
  unknownText: { color: colors.text.secondaryAccessible, fontSize: 14, lineHeight: 20 },
});

export default RitualConfiguratorSheet;
