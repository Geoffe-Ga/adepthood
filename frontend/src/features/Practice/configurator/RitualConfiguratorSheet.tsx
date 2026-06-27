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
import { CUSTOM_NAME_MAX, validateCustomName, validateModeConfig } from '../engine/validation';
import RecipePickerModal from '../recipes/RecipePickerModal';

import CardMeditationForm from './forms/CardMeditationForm';
import CountUpForm from './forms/CountUpForm';
import IntervalBellForm from './forms/IntervalBellForm';
import MeditationTimerForm from './forms/MeditationTimerForm';
import MetronomeForm from './forms/MetronomeForm';
import RandomIntervalBellForm from './forms/RandomIntervalBellForm';
import RepCounterForm from './forms/RepCounterForm';
import SenseGroundingForm from './forms/SenseGroundingForm';
import { ErrorList } from './forms/shared';
import TarotForm from './forms/TarotForm';

import { type UserPractice, type UserPracticeCustomize, userPractices } from '@/api';
import { formatApiError } from '@/api/errorMessages';
import { BORDER_RADIUS, SPACING, colors, shadows } from '@/design/tokens';

/** Modes that have a recipe library backing them; see backend `RECIPE_MODES`. */
const RECIPE_LIBRARY_MODES = new Set(['sense_grounding', 'tallied_grounding']);

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
  const edit = useEditState(props.initialName, props.initialConfig);
  const state = useSaveState();
  const [pickerVisible, setPickerVisible] = useState(false);
  const canSave = edit.dirty && edit.errors.length === 0 && !state.submitting;
  const recipeLibraryAvailable = RECIPE_LIBRARY_MODES.has(edit.config.mode);
  return (
    <Modal visible={props.visible} transparent animationType="slide" onRequestClose={props.onClose}>
      <ConfiguratorSheetBody
        edit={edit}
        state={state}
        canSave={canSave}
        aspect={props.aspect ?? null}
        recipeLibraryAvailable={recipeLibraryAvailable}
        onOpenRecipePicker={() => setPickerVisible(true)}
        onSave={() => state.save(props, { name: edit.name, config: edit.config })}
        onCancel={props.onClose}
        onReset={() => state.reset(props)}
      />
      {recipeLibraryAvailable && (
        <RecipePickerModal
          visible={pickerVisible}
          mode={edit.config.mode as 'sense_grounding' | 'tallied_grounding'}
          userPracticeId={props.userPracticeId}
          onClose={() => setPickerVisible(false)}
          onApplied={(updated) => {
            props.onSaved?.(updated);
            props.onClose();
          }}
        />
      )}
    </Modal>
  );
};

interface ConfiguratorSheetBodyProps {
  edit: EditState;
  state: SaveState;
  canSave: boolean;
  aspect: string | null;
  recipeLibraryAvailable: boolean;
  onOpenRecipePicker: () => void;
  onSave: () => void;
  onCancel: () => void;
  onReset: () => void;
}

const ConfiguratorSheetBody = (props: ConfiguratorSheetBodyProps): React.JSX.Element => (
  <KeyboardAvoidingView
    behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    style={styles.overlay}
    testID="ritual-configurator-overlay"
  >
    <View style={styles.sheet} testID="ritual-configurator-sheet">
      <ConfiguratorHeader
        name={props.edit.name}
        aspect={props.aspect}
        onNameChange={props.edit.setName}
        onCancel={props.onCancel}
        onSave={props.onSave}
        canSave={props.canSave}
      />
      <ScrollView style={styles.body} keyboardShouldPersistTaps="handled">
        {props.recipeLibraryAvailable && <RecipeLibraryButton onPress={props.onOpenRecipePicker} />}
        <ConfiguratorBody config={props.edit.config} onChange={props.edit.setConfig} />
        <ErrorList errors={props.edit.errors} />
        {props.state.apiError !== null && (
          <Text style={styles.apiError} testID="ritual-configurator-api-error">
            {props.state.apiError}
          </Text>
        )}
        <ResetButton disabled={props.state.submitting} onPress={props.onReset} />
      </ScrollView>
    </View>
  </KeyboardAvoidingView>
);

interface RecipeLibraryButtonProps {
  onPress: () => void;
}

const RecipeLibraryButton = ({ onPress }: RecipeLibraryButtonProps): React.JSX.Element => (
  <TouchableOpacity
    accessibilityRole="button"
    accessibilityLabel="Browse recipe library"
    onPress={onPress}
    style={styles.recipeLibraryButton}
    testID="ritual-configurator-recipe-library"
  >
    <Text style={styles.recipeLibraryText}>Browse recipe library →</Text>
  </TouchableOpacity>
);

interface EditState {
  name: string;
  config: ModeConfig;
  setName: (next: string) => void;
  setConfig: (next: ModeConfig) => void;
  errors: readonly string[];
  dirty: boolean;
}

function useEditState(initialName: string, initialConfig: ModeConfig): EditState {
  const [name, setName] = useState(initialName);
  const [config, setConfig] = useState<ModeConfig>(initialConfig);
  const dirty = useMemo(
    () => name !== initialName || !deepEqualConfig(config, initialConfig),
    [name, config, initialName, initialConfig],
  );
  const errors = useMemo(
    () => [...validateCustomName(name), ...validateModeConfig(config)],
    [name, config],
  );
  return { name, config, setName, setConfig, errors, dirty };
}

interface ResetButtonProps {
  disabled: boolean;
  onPress: () => void;
}

const ResetButton = ({ disabled, onPress }: ResetButtonProps): React.JSX.Element => (
  <TouchableOpacity
    accessibilityRole="button"
    accessibilityLabel="Reset to default"
    accessibilityState={{ disabled }}
    onPress={disabled ? undefined : onPress}
    style={styles.resetButton}
    testID="ritual-configurator-reset"
    disabled={disabled}
  >
    <Text style={styles.resetText}>Reset to default</Text>
  </TouchableOpacity>
);

/** States plainly that the configurator edits the user's own copy, not the
 * shared practice — disambiguates "Adjust" from "Duplicate & edit"/"Change". */
const ConfiguratorTitle = (): React.JSX.Element => (
  <>
    <Text style={styles.headerTitle} testID="ritual-configurator-title">
      Adjust your practice
    </Text>
    <Text style={styles.headerSubtitle} testID="ritual-configurator-subtitle">
      Changes apply only to your copy — the shared practice is unchanged.
    </Text>
  </>
);

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
    <ConfiguratorTitle />
    <View style={styles.nameRow}>
      <TextInput
        style={styles.nameInput}
        value={name}
        onChangeText={onNameChange}
        placeholder="Practice name"
        maxLength={CUSTOM_NAME_MAX}
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
    case 'random_interval_bell':
      return <RandomIntervalBellForm value={config} onChange={onChange} />;
    case 'rep_counter':
      return <RepCounterForm value={config} onChange={onChange} />;
    case 'sense_grounding':
      return <SenseGroundingForm value={config} onChange={onChange} />;
    case 'tarot':
      return <TarotForm value={config} onChange={onChange} />;
    case 'card_meditation':
      return <CardMeditationForm value={config} onChange={onChange} />;
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
        mode_config_override: values.config,
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

/**
 * Structural equality check for ``ModeConfig`` payloads.
 *
 * ``JSON.stringify`` is a deep, value-based comparison (not shallow). V8
 * preserves insertion order for string keys, and the discriminated-union
 * configs are constructed from spread + literal patches so key order is
 * stable in practice. If a future ``ModeConfig`` variant carries dynamic
 * keys this will need a proper structural equality helper.
 */
function deepEqualConfig(a: ModeConfig, b: ModeConfig): boolean {
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
  headerTitle: { fontSize: 18, fontWeight: '700', color: colors.text.primary },
  headerSubtitle: { fontSize: 13, color: colors.text.secondary },
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
  recipeLibraryButton: {
    marginBottom: SPACING.md,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: colors.background.card,
    borderWidth: 1,
    borderColor: colors.background.accent,
    alignItems: 'center',
  },
  recipeLibraryText: { color: colors.text.primary, fontSize: 14, fontWeight: '600' },
});

export default RitualConfiguratorSheet;
