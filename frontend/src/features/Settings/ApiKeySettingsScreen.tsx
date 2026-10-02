import { ShieldCheck } from 'lucide-react-native';
import React, { useCallback, useMemo, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
  ActivityIndicator,
  Linking,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';

import ConfirmDialog from '../Habits/components/ConfirmDialog';

import { BYOK_DETAIL_DISCLOSURE } from './byokDisclosure';
import { BYOK_PROVIDERS, providerForKey } from './byokProviders';
import {
  LOCAL_MODEL_OFF_NOTE,
  LOCAL_MODEL_ON_NOTE,
  LOCAL_MODEL_SAVE_FAILED,
  LOCAL_MODEL_SWITCH_DESCRIPTION,
  LOCAL_MODEL_SWITCH_LABEL,
} from './localModelCopy';
import { SettingsFeedbackBanner } from './shared/SettingsFeedbackBanner';
import {
  SETTINGS_BUTTON_PADDING,
  SETTINGS_MONOSPACE_FONT,
  settingsFormStyles,
  settingsFormType,
} from './shared/settingsFormLayout';
import { SettingsSwitchRow } from './shared/SettingsSwitchRow';
import type { SettingsFormState } from './shared/useSettingsForm';
import { useSettingsFormState, useSettingsSubmit } from './shared/useSettingsForm';

import { ScreenScaffold } from '@/components/layout/ScreenScaffold';
import type {
  ApiKeyClearResult,
  ApiKeySaveResult,
  LocalModelSaveResult,
} from '@/context/ApiKeyContext';
import { useApiKey } from '@/context/ApiKeyContext';
import { BORDER_RADIUS, SPACING, colors, ink, surface } from '@/design/tokens';
import type { RootStackParamList } from '@/navigation/RootStack';

/**
 * BYOK ("Bring Your Own Key") settings for model-powered features.
 *
 * Lets a user paste an OpenAI or Anthropic API key that is stored **only on
 * their device** via SecureStore and is attached per-request to the supported
 * LLM routes via the ``X-LLM-API-Key`` header (issue #185). The backend passes
 * it to the provider without persisting, logging, or echoing it; reveal toggles
 * only show the masked-by-default value locally in this screen.
 *
 * Above the key sits the "Use Adepthood's own model" switch: the open-source
 * model Adepthood runs on servers it operates, in place of a provider reached
 * with a key. While it is on the whole key area is greyed and inert — the
 * switch is the way to use it again — and a key already saved stays on the
 * device but is not sent (``ApiKeyContext`` withholds it per request).
 */

const MAX_KEY_LENGTH = 256;
const MIN_KEY_LENGTH = 10;
const PLACEHOLDER_KEY = 'sk-... or sk-ant-...';
const MASK_VISIBLE_CHARS = 4;

// Shown when ApiKeyContext.loadError is set — SecureStore is unavailable, so the
// key can't persist. Kept generic (never the raw thrown error) to avoid leaking
// keychain internals into the UI.
export const SECURE_STORAGE_WARNING =
  "Secure storage is unavailable on this device, so your API key can't be saved. It will still work for this session, but it won't persist after you close the app. Try restarting the app, then save your key again.";

// Built from the provider map so the error copy can never drift from the
// supported set: e.g. `"sk-" (OpenAI) or "sk-ant-" (Anthropic)`.
const PREFIX_SUMMARY = BYOK_PROVIDERS.map((p) => `"${p.keyPrefix}" (${p.label})`).join(' or ');

interface KeyValidationError {
  code: 'empty' | 'too_short' | 'too_long' | 'bad_prefix';
  message: string;
}

export function validateUserApiKey(raw: string): KeyValidationError | null {
  const key = raw.trim();
  if (!key) {
    return { code: 'empty', message: 'Paste an API key before saving.' };
  }
  if (key.length < MIN_KEY_LENGTH) {
    return { code: 'too_short', message: 'This key is shorter than any real API key.' };
  }
  if (key.length > MAX_KEY_LENGTH) {
    return { code: 'too_long', message: 'This key is longer than any real API key.' };
  }
  if (providerForKey(key) === null) {
    return {
      code: 'bad_prefix',
      message: `API keys start with ${PREFIX_SUMMARY}.`,
    };
  }
  return null;
}

function maskKey(key: string): string {
  if (key.length <= MASK_VISIBLE_CHARS * 2) return '••••••••';
  return `${key.slice(0, MASK_VISIBLE_CHARS)}••••${key.slice(-MASK_VISIBLE_CHARS)}`;
}

interface Props {
  navigation?: {
    goBack?: () => void;
    /**
     * Stack navigate — used by the "Time zone" settings entry (issue #261).
     * Typed against the whole param list (not a single literal) so future
     * entries from this screen don't require a Props change; duck-typed
     * rather than ``NavigationProp`` so tests can pass a bare ``jest.fn()``.
     */
    navigate?: (_screen: keyof RootStackParamList) => void;
  };
}

interface StoredKeyCardProps {
  apiKey: string;
  disabled: boolean;
  onRequestRemove: () => void;
}

const StoredKeyCard = ({
  apiKey,
  disabled,
  onRequestRemove,
}: StoredKeyCardProps): React.JSX.Element => {
  const face = settingsFormType(useWindowDimensions().width);
  return (
    <View style={styles.storedCard} testID="stored-key-card">
      <Text style={[face.cardLabel, settingsFormStyles.cardLabel]}>Stored on this device</Text>
      <Text style={styles.storedValue}>{maskKey(apiKey)}</Text>
      <TouchableOpacity
        onPress={onRequestRemove}
        style={[styles.button, styles.destructiveButton]}
        disabled={disabled}
        testID="remove-key-button"
        accessibilityLabel="Remove stored API key"
        accessibilityRole="button"
      >
        <Text style={styles.destructiveButtonText}>Remove key</Text>
      </TouchableOpacity>
    </View>
  );
};

interface KeyInputRowProps {
  draft: string;
  reveal: boolean;
  disabled: boolean;
  onChangeText: (_v: string) => void;
  onToggleReveal: () => void;
}

const KeyInputRow = ({
  draft,
  reveal,
  disabled,
  onChangeText,
  onToggleReveal,
}: KeyInputRowProps): React.JSX.Element => (
  <View style={styles.inputRow}>
    <TextInput
      style={styles.input}
      placeholder={PLACEHOLDER_KEY}
      value={draft}
      onChangeText={onChangeText}
      autoCapitalize="none"
      autoCorrect={false}
      secureTextEntry={!reveal}
      editable={!disabled}
      accessibilityState={{ disabled }}
      testID="api-key-input"
    />
    <TouchableOpacity
      onPress={onToggleReveal}
      style={styles.revealButton}
      disabled={disabled}
      testID="reveal-toggle"
      accessibilityLabel={reveal ? 'Hide API key' : 'Show API key'}
      accessibilityState={{ disabled }}
    >
      <Text style={styles.revealButtonText}>{reveal ? 'Hide' : 'Show'}</Text>
    </TouchableOpacity>
  </View>
);

const REMOVE_KEY_DIALOG_TITLE = 'Remove API key?';
const REMOVE_KEY_DIALOG_BODY =
  'BotMason will fall back to the shared server key (if configured). You can add your own key again at any time.';
const REMOVE_KEY_CANCEL_LABEL = 'Cancel';
const REMOVE_KEY_CONFIRM_LABEL = 'Remove';

interface RemoveConfirmation {
  request: () => void;
  visible: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Drives the rendered "Remove API key?" dialog. `Alert.alert` is a no-op on
 * react-native-web (#2928), so the confirm is a `ConfirmDialog` whose
 * visibility lives here rather than a native alert whose buttons never fire.
 */
function useRemoveConfirmation(performClear: () => Promise<void>): RemoveConfirmation {
  const [visible, setVisible] = useState(false);
  const request = useCallback(() => setVisible(true), []);
  const onCancel = useCallback(() => setVisible(false), []);
  const onConfirm = useCallback(() => {
    setVisible(false);
    void performClear();
  }, [performClear]);
  return { request, visible, onCancel, onConfirm };
}

const RemoveKeyDialog = ({
  confirmation,
}: {
  confirmation: RemoveConfirmation;
}): React.JSX.Element => (
  <ConfirmDialog
    visible={confirmation.visible}
    title={REMOVE_KEY_DIALOG_TITLE}
    message={REMOVE_KEY_DIALOG_BODY}
    cancelLabel={REMOVE_KEY_CANCEL_LABEL}
    confirmLabel={REMOVE_KEY_CONFIRM_LABEL}
    destructive
    testID="remove-key-dialog"
    cancelTestID="remove-key-cancel"
    confirmTestID="remove-key-confirm"
    onCancel={confirmation.onCancel}
    onConfirm={confirmation.onConfirm}
  />
);

interface LocalModelChoiceProps {
  localModel: boolean;
  onToggleLocalModel: (_next: boolean) => void;
}

interface ScreenBodyProps extends LocalModelChoiceProps {
  apiKey: string | null;
  draft: string;
  reveal: boolean;
  submitting: boolean;
  error: string | null;
  status: string | null;
  storageWarning: string | null;
  onChangeDraft: (_v: string) => void;
  onToggleReveal: () => void;
  onRequestRemove: () => void;
  onSave: () => void;
  onBack?: () => void;
  onOpenTimezone?: () => void;
}

/** The switch, and under it which of the two paths requests take right now. */
const LocalModelChoice = ({
  localModel,
  onToggleLocalModel,
}: LocalModelChoiceProps): React.JSX.Element => {
  const face = settingsFormType(useWindowDimensions().width);
  return (
    <View style={styles.localModel} testID="local-model-choice">
      <SettingsSwitchRow
        icon={ShieldCheck}
        label={LOCAL_MODEL_SWITCH_LABEL}
        description={LOCAL_MODEL_SWITCH_DESCRIPTION}
        value={localModel}
        onValueChange={onToggleLocalModel}
        testID="local-model"
      />
      <Text style={[face.cardLabel, styles.localModelNote]} testID="local-model-note">
        {localModel ? LOCAL_MODEL_ON_NOTE : LOCAL_MODEL_OFF_NOTE}
      </Text>
    </View>
  );
};

const ScreenIntro = ({ apiKey }: { apiKey: string | null }): React.JSX.Element => {
  const face = settingsFormType(useWindowDimensions().width);
  return (
    <>
      <Text style={[face.title, settingsFormStyles.title]} accessibilityRole="header">
        BotMason API Key
      </Text>
      <Text style={settingsFormStyles.body}>{BYOK_DETAIL_DISCLOSURE}</Text>
      {!apiKey && (
        <Text style={styles.hint} testID="no-key-hint">
          No key saved yet. BotMason will use the shared server key if one is configured.
        </Text>
      )}
    </>
  );
};

const ProviderDirectory = (): React.JSX.Element => (
  <View style={styles.providerSection} testID="provider-directory">
    <Text style={settingsFormStyles.inputLabel}>Supported providers</Text>
    {BYOK_PROVIDERS.map((provider) => (
      <View key={provider.id} style={styles.providerRow}>
        <View style={styles.providerInfo}>
          <Text style={styles.providerName}>{provider.label}</Text>
          <Text style={styles.providerHint}>{provider.hint}</Text>
        </View>
        <TouchableOpacity
          onPress={() => void Linking.openURL(provider.keyPageUrl)}
          testID={`get-key-link-${provider.id}`}
          accessibilityLabel={`Get your ${provider.label} API key`}
          accessibilityRole="link"
        >
          <Text style={settingsFormStyles.link}>Get your API key</Text>
        </TouchableOpacity>
      </View>
    ))}
  </View>
);

const DetectedProvider = ({ draft }: { draft: string }): React.JSX.Element | null => {
  const provider = providerForKey(draft.trim());
  if (!provider) return null;
  return (
    <Text style={styles.detected} testID="detected-provider">
      {provider.label} key detected — it will be saved on this device only.
    </Text>
  );
};

const SaveKeyButton = ({
  submitting,
  disabled,
  onSave,
}: {
  submitting: boolean;
  disabled: boolean;
  onSave: () => void;
}): React.JSX.Element => (
  <TouchableOpacity
    onPress={onSave}
    style={settingsFormStyles.primaryButton}
    disabled={submitting || disabled}
    testID="save-key-button"
    accessibilityLabel="Save API key"
    accessibilityRole="button"
    accessibilityState={{ disabled: submitting || disabled, busy: submitting }}
  >
    <Text style={settingsFormStyles.primaryButtonText}>{submitting ? 'Saving…' : 'Save key'}</Text>
  </TouchableOpacity>
);

const ScreenFooter = ({
  onBack,
  onOpenTimezone,
}: {
  onBack?: () => void;
  onOpenTimezone?: () => void;
}): React.JSX.Element => (
  <>
    {onOpenTimezone && (
      <TouchableOpacity
        onPress={onOpenTimezone}
        style={settingsFormStyles.linkRow}
        testID="open-timezone-settings"
        accessibilityLabel="Time zone settings"
        accessibilityRole="link"
      >
        <Text style={settingsFormStyles.link}>Time zone settings</Text>
      </TouchableOpacity>
    )}
    {onBack && (
      <TouchableOpacity
        onPress={onBack}
        style={settingsFormStyles.linkRow}
        accessibilityLabel="Go back"
        accessibilityRole="link"
      >
        <Text style={settingsFormStyles.link}>Back</Text>
      </TouchableOpacity>
    )}
  </>
);

type KeyAreaProps = Omit<ScreenBodyProps, 'storageWarning' | 'onBack' | 'onOpenTimezone'>;

/**
 * Everything about the key itself. Greyed and inert while Adepthood's own
 * model is chosen: the switch above is the one way back in, so nothing in
 * here can be tapped into a half-state.
 */
const KeyArea = (props: KeyAreaProps): React.JSX.Element => {
  const { apiKey, localModel, submitting } = props;
  const inert = localModel;
  return (
    <View
      style={inert ? styles.keyAreaInert : null}
      pointerEvents={inert ? 'none' : 'auto'}
      accessibilityState={{ disabled: inert }}
      testID="api-key-area"
    >
      <ProviderDirectory />
      {apiKey && (
        <StoredKeyCard
          apiKey={apiKey}
          disabled={submitting || inert}
          onRequestRemove={props.onRequestRemove}
        />
      )}
      <Text style={settingsFormStyles.inputLabel}>{apiKey ? 'Replace key' : 'Add your key'}</Text>
      <KeyInputRow
        draft={props.draft}
        reveal={props.reveal}
        disabled={inert}
        onChangeText={props.onChangeDraft}
        onToggleReveal={props.onToggleReveal}
      />
      <DetectedProvider draft={props.draft} />
      <SettingsFeedbackBanner idPrefix="api-key" error={props.error} status={props.status} />
      <SaveKeyButton submitting={submitting} disabled={inert} onSave={props.onSave} />
    </View>
  );
};

const ScreenBody = ({
  storageWarning,
  onBack,
  onOpenTimezone,
  ...keyArea
}: ScreenBodyProps): React.JSX.Element => (
  <>
    <ScreenIntro apiKey={keyArea.apiKey} />
    <SettingsFeedbackBanner idPrefix="api-key-storage" error={storageWarning} status={null} />
    <LocalModelChoice
      localModel={keyArea.localModel}
      onToggleLocalModel={keyArea.onToggleLocalModel}
    />
    <KeyArea {...keyArea} />
    <ScreenFooter onBack={onBack} onOpenTimezone={onOpenTimezone} />
  </>
);

function useSaveKeyHandler(
  form: SettingsFormState,
  setReveal: Dispatch<SetStateAction<boolean>>,
  saveApiKey: (_k: string) => Promise<ApiKeySaveResult>,
): () => Promise<void> {
  const { draft, setDraft, setStatus } = form;
  const validate = useCallback(() => validateUserApiKey(draft)?.message ?? null, [draft]);
  const perform = useCallback(async () => {
    const result = await saveApiKey(draft.trim());
    setDraft('');
    setReveal(false);
    if (result.persisted) {
      setStatus('API key saved on this device.');
    }
  }, [draft, saveApiKey, setDraft, setReveal, setStatus]);
  const onError = useCallback(
    (err: unknown) =>
      err instanceof Error && err.message ? err.message : 'Could not save the API key.',
    [],
  );
  return useSettingsSubmit(form, { validate, perform, onError });
}

function useClearKeyHandler(
  form: SettingsFormState,
  clearApiKey: () => Promise<ApiKeyClearResult>,
): () => Promise<void> {
  const { setStatus } = form;
  const validate = useCallback(() => null, []);
  const perform = useCallback(async () => {
    const result = await clearApiKey();
    if (result.cleared) {
      setStatus('API key removed from this device.');
    }
  }, [clearApiKey, setStatus]);
  const onError = useCallback(
    (err: unknown) =>
      err instanceof Error && err.message ? err.message : 'Could not remove the API key.',
    [],
  );
  return useSettingsSubmit(form, { validate, perform, onError });
}

/**
 * Flip the model choice. Applied at once; if the device could not keep it, the
 * form says so in its own banner rather than pretending it will outlive the app.
 */
function useLocalModelToggle(
  form: SettingsFormState,
  setLocalModel: (_value: boolean) => Promise<LocalModelSaveResult>,
): (_next: boolean) => void {
  const { setError, setStatus } = form;
  return useCallback(
    (next: boolean) => {
      setStatus(null);
      void setLocalModel(next).then((result) => {
        setError(result.persisted ? null : LOCAL_MODEL_SAVE_FAILED);
      });
    },
    [setError, setLocalModel, setStatus],
  );
}

/** Typing into the key field clears whatever the last submit said. */
function useDraftChange(form: SettingsFormState): (_value: string) => void {
  const { setDraft, setError, setStatus } = form;
  return useCallback(
    (value: string) => {
      setDraft(value);
      setError(null);
      setStatus(null);
    },
    [setDraft, setError, setStatus],
  );
}

function useScreenNavHandlers(navigation: Props['navigation']): {
  onBack?: () => void;
  onOpenTimezone?: () => void;
} {
  const onBack = useMemo(
    () => (navigation?.goBack ? () => navigation.goBack?.() : undefined),
    [navigation],
  );
  const onOpenTimezone = useMemo(
    () => (navigation?.navigate ? () => navigation.navigate?.('TimezoneSettings') : undefined),
    [navigation],
  );
  return { onBack, onOpenTimezone };
}

export default function ApiKeySettingsScreen({ navigation }: Props = {}): React.JSX.Element {
  const { apiKey, isLoading, loadError, saveApiKey, clearApiKey, localModel, setLocalModel } =
    useApiKey();
  const storageWarning = loadError ? SECURE_STORAGE_WARNING : null;
  const form = useSettingsFormState('');
  const [reveal, setReveal] = useState(false);
  const handleSave = useSaveKeyHandler(form, setReveal, saveApiKey);
  const performClear = useClearKeyHandler(form, clearApiKey);
  const removeConfirmation = useRemoveConfirmation(performClear);
  const onToggleLocalModel = useLocalModelToggle(form, setLocalModel);
  const onChangeDraft = useDraftChange(form);
  const toggleReveal = useCallback(() => setReveal((prev) => !prev), [setReveal]);
  const { onBack, onOpenTimezone } = useScreenNavHandlers(navigation);

  if (isLoading) {
    return (
      <View style={styles.loadingContainer} testID="api-key-loading">
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <ScreenScaffold scroll testID="api-key-settings-screen">
      <ScreenBody
        apiKey={apiKey}
        draft={form.draft}
        reveal={reveal}
        submitting={form.submitting}
        error={form.error}
        status={form.status}
        storageWarning={storageWarning}
        localModel={localModel}
        onToggleLocalModel={onToggleLocalModel}
        onChangeDraft={onChangeDraft}
        onToggleReveal={toggleReveal}
        onRequestRemove={removeConfirmation.request}
        onSave={handleSave}
        onBack={onBack}
        onOpenTimezone={onOpenTimezone}
      />
      <RemoveKeyDialog confirmation={removeConfirmation} />
    </ScreenScaffold>
  );
}

const PROVIDER_HINT_MARGIN_TOP = 2;
/** The key area while Adepthood's own model is chosen: legible, plainly inert. */
const KEY_AREA_INERT_OPACITY = 0.45;

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: surface.canvas,
  },
  storedCard: {
    borderWidth: 1,
    borderColor: surface.hairline,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.lg,
    marginBottom: SPACING.xl,
    backgroundColor: surface.raised,
  },
  storedValue: {
    fontSize: 18,
    fontFamily: SETTINGS_MONOSPACE_FONT,
    marginTop: SPACING.sm,
    marginBottom: SPACING.lg,
    color: ink.primary,
  },
  hint: {
    fontSize: 14,
    color: ink.muted,
    marginBottom: SPACING.xl,
    fontStyle: 'italic',
  },
  inputRow: { flexDirection: 'row', alignItems: 'stretch', marginBottom: SPACING.md },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: surface.hairline,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.md,
    fontSize: 16,
    backgroundColor: surface.raised,
    color: ink.primary,
  },
  revealButton: {
    borderWidth: 1,
    borderColor: surface.hairline,
    borderLeftWidth: 0,
    borderTopRightRadius: BORDER_RADIUS.md,
    borderBottomRightRadius: BORDER_RADIUS.md,
    paddingHorizontal: SPACING.md,
    justifyContent: 'center',
    backgroundColor: surface.sunken,
  },
  revealButtonText: { fontSize: 14, color: ink.primary, fontWeight: '600' },
  button: {
    borderRadius: BORDER_RADIUS.md,
    padding: SETTINGS_BUTTON_PADDING,
    alignItems: 'center',
  },
  destructiveButton: {
    backgroundColor: colors.destructive.background,
    borderWidth: 1,
    borderColor: colors.destructive.border,
  },
  destructiveButtonText: { color: colors.destructive.text, fontWeight: '600' },
  providerSection: { marginBottom: SPACING.xl },
  providerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: SPACING.sm,
    borderBottomWidth: 1,
    borderBottomColor: surface.hairline,
  },
  providerInfo: { flex: 1, paddingRight: SPACING.md },
  providerName: { fontSize: 15, fontWeight: '600', color: ink.primary },
  providerHint: { fontSize: 13, color: ink.soft, marginTop: PROVIDER_HINT_MARGIN_TOP },
  detected: { color: colors.successText, marginBottom: SPACING.md, fontSize: 13 },
  localModel: { marginBottom: SPACING.xl },
  /** Ink and spacing only: the face is ``settingsFormType(width).cardLabel`` (the ramp caption). */
  localModelNote: { color: ink.soft, marginTop: SPACING.sm },
  keyAreaInert: { opacity: KEY_AREA_INERT_OPACITY },
});

export { styles as apiKeySettingsStyles };
