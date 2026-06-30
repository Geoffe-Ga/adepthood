import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { BYOK_PROVIDERS, providerForKey } from './byokProviders';

import { ScreenScaffold } from '@/components/layout/ScreenScaffold';
import { useApiKey } from '@/context/ApiKeyContext';
import { BORDER_RADIUS, SPACING, accent, colors, ink, surface } from '@/design/tokens';
import type { RootStackParamList } from '@/navigation/RootStack';

/**
 * BYOK ("Bring Your Own Key") settings for BotMason chat.
 *
 * Lets a user paste an OpenAI or Anthropic API key that is stored **only on
 * their device** via SecureStore and is attached per-request to
 * ``/journal/chat`` via the ``X-LLM-API-Key`` header (issue #185). The key is
 * never uploaded to the backend database and is masked by default — reveal
 * toggles only show the value locally in this screen.
 */

const MAX_KEY_LENGTH = 256;
const MIN_KEY_LENGTH = 10;
const PLACEHOLDER_KEY = 'sk-... or sk-ant-...';
const MASK_VISIBLE_CHARS = 4;

// Built from the provider map so the error copy can never drift from the
// supported set: e.g. `"sk-" (OpenAI) or "sk-ant-" (Anthropic)`.
const _PREFIX_SUMMARY = BYOK_PROVIDERS.map((p) => `"${p.keyPrefix}" (${p.label})`).join(' or ');

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
      message: `API keys start with ${_PREFIX_SUMMARY}.`,
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
}: StoredKeyCardProps): React.JSX.Element => (
  <View style={styles.storedCard} testID="stored-key-card">
    <Text style={styles.storedLabel}>Stored on this device</Text>
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

interface KeyInputRowProps {
  draft: string;
  reveal: boolean;
  onChangeText: (_v: string) => void;
  onToggleReveal: () => void;
}

const KeyInputRow = ({
  draft,
  reveal,
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
      testID="api-key-input"
    />
    <TouchableOpacity
      onPress={onToggleReveal}
      style={styles.revealButton}
      testID="reveal-toggle"
      accessibilityLabel={reveal ? 'Hide API key' : 'Show API key'}
    >
      <Text style={styles.revealButtonText}>{reveal ? 'Hide' : 'Show'}</Text>
    </TouchableOpacity>
  </View>
);

function useRemoveConfirmation(performClear: () => Promise<void>): () => void {
  return useCallback(() => {
    Alert.alert(
      'Remove API key?',
      'BotMason will fall back to the shared server key (if configured). You can add your own key again at any time.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => void performClear() },
      ],
    );
  }, [performClear]);
}

interface FeedbackBannerProps {
  error: string | null;
  status: string | null;
}

const FeedbackBanner = ({ error, status }: FeedbackBannerProps): React.JSX.Element | null => {
  if (error) {
    return (
      <Text style={styles.error} testID="api-key-error">
        {error}
      </Text>
    );
  }
  if (status) {
    return (
      <Text style={styles.success} testID="api-key-status">
        {status}
      </Text>
    );
  }
  return null;
};

interface ScreenBodyProps {
  apiKey: string | null;
  draft: string;
  reveal: boolean;
  submitting: boolean;
  error: string | null;
  status: string | null;
  onChangeDraft: (_v: string) => void;
  onToggleReveal: () => void;
  onRequestRemove: () => void;
  onSave: () => void;
  onBack?: () => void;
  onOpenTimezone?: () => void;
}

const ScreenIntro = ({ apiKey }: { apiKey: string | null }): React.JSX.Element => (
  <>
    <Text style={styles.title}>BotMason API Key</Text>
    <Text style={styles.body}>
      Bring your own API key from a supported provider. It is stored only on this device and sent
      with every BotMason request via the X-LLM-API-Key header. We never upload it to our servers.
    </Text>
    {!apiKey && (
      <Text style={styles.hint} testID="no-key-hint">
        No key saved yet. BotMason will use the shared server key if one is configured.
      </Text>
    )}
  </>
);

const ProviderDirectory = (): React.JSX.Element => (
  <View style={styles.providerSection} testID="provider-directory">
    <Text style={styles.inputLabel}>Supported providers</Text>
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
          <Text style={styles.link}>Get your API key</Text>
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

const ScreenFooter = ({
  submitting,
  onSave,
  onBack,
  onOpenTimezone,
}: {
  submitting: boolean;
  onSave: () => void;
  onBack?: () => void;
  onOpenTimezone?: () => void;
}): React.JSX.Element => (
  <>
    <TouchableOpacity
      onPress={onSave}
      style={[styles.button, styles.primaryButton]}
      disabled={submitting}
      testID="save-key-button"
      accessibilityLabel="Save API key"
      accessibilityRole="button"
      accessibilityState={{ disabled: submitting, busy: submitting }}
    >
      <Text style={styles.primaryButtonText}>{submitting ? 'Saving…' : 'Save key'}</Text>
    </TouchableOpacity>
    {onOpenTimezone && (
      <TouchableOpacity
        onPress={onOpenTimezone}
        style={styles.linkRow}
        testID="open-timezone-settings"
        accessibilityLabel="Time zone settings"
        accessibilityRole="link"
      >
        <Text style={styles.link}>Time zone settings</Text>
      </TouchableOpacity>
    )}
    {onBack && (
      <TouchableOpacity
        onPress={onBack}
        style={styles.linkRow}
        accessibilityLabel="Go back"
        accessibilityRole="link"
      >
        <Text style={styles.link}>Back</Text>
      </TouchableOpacity>
    )}
  </>
);

const ScreenBody = ({
  apiKey,
  draft,
  reveal,
  submitting,
  error,
  status,
  onChangeDraft,
  onToggleReveal,
  onRequestRemove,
  onSave,
  onBack,
  onOpenTimezone,
}: ScreenBodyProps): React.JSX.Element => (
  <>
    <ScreenIntro apiKey={apiKey} />
    <ProviderDirectory />
    {apiKey && (
      <StoredKeyCard apiKey={apiKey} disabled={submitting} onRequestRemove={onRequestRemove} />
    )}
    <Text style={styles.inputLabel}>{apiKey ? 'Replace key' : 'Add your key'}</Text>
    <KeyInputRow
      draft={draft}
      reveal={reveal}
      onChangeText={onChangeDraft}
      onToggleReveal={onToggleReveal}
    />
    <DetectedProvider draft={draft} />
    <FeedbackBanner error={error} status={status} />
    <ScreenFooter
      submitting={submitting}
      onSave={onSave}
      onBack={onBack}
      onOpenTimezone={onOpenTimezone}
    />
  </>
);

interface ApiKeyScreenState {
  draft: string;
  reveal: boolean;
  submitting: boolean;
  error: string | null;
  status: string | null;
  setDraft: React.Dispatch<React.SetStateAction<string>>;
  setReveal: React.Dispatch<React.SetStateAction<boolean>>;
  setSubmitting: React.Dispatch<React.SetStateAction<boolean>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setStatus: React.Dispatch<React.SetStateAction<string | null>>;
}

function useApiKeyScreenState(): ApiKeyScreenState {
  const [draft, setDraft] = useState('');
  const [reveal, setReveal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  return {
    draft,
    reveal,
    submitting,
    error,
    status,
    setDraft,
    setReveal,
    setSubmitting,
    setError,
    setStatus,
  };
}

function useSaveKeyHandler(
  state: ApiKeyScreenState,
  saveApiKey: (_k: string) => Promise<void>,
): () => Promise<void> {
  const { draft, setDraft, setReveal, setSubmitting, setError, setStatus } = state;
  return useCallback(async () => {
    setStatus(null);
    const problem = validateUserApiKey(draft);
    if (problem) {
      setError(problem.message);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await saveApiKey(draft.trim());
      setDraft('');
      setReveal(false);
      setStatus('API key saved on this device.');
    } catch (err) {
      setError((err as Error).message ?? 'Could not save the API key.');
    } finally {
      setSubmitting(false);
    }
  }, [draft, saveApiKey, setDraft, setReveal, setSubmitting, setError, setStatus]);
}

function useClearKeyHandler(
  state: ApiKeyScreenState,
  clearApiKey: () => Promise<void>,
): () => Promise<void> {
  const { setStatus, setError, setSubmitting } = state;
  return useCallback(async () => {
    setStatus(null);
    setSubmitting(true);
    try {
      await clearApiKey();
      setStatus('API key removed from this device.');
    } catch (err) {
      setError((err as Error).message ?? 'Could not remove the API key.');
    } finally {
      setSubmitting(false);
    }
  }, [clearApiKey, setStatus, setError, setSubmitting]);
}

export default function ApiKeySettingsScreen({ navigation }: Props = {}): React.JSX.Element {
  const { apiKey, isLoading, saveApiKey, clearApiKey } = useApiKey();
  const state = useApiKeyScreenState();
  const handleSave = useSaveKeyHandler(state, saveApiKey);
  const performClear = useClearKeyHandler(state, clearApiKey);
  const handleRequestRemove = useRemoveConfirmation(performClear);

  const onChangeDraft = useCallback(
    (value: string) => {
      state.setDraft(value);
      state.setError(null);
    },
    [state],
  );
  const toggleReveal = useCallback(() => state.setReveal((prev) => !prev), [state]);
  const onBack = useMemo(
    () => (navigation?.goBack ? () => navigation.goBack?.() : undefined),
    [navigation],
  );
  const onOpenTimezone = useMemo(
    () => (navigation?.navigate ? () => navigation.navigate?.('TimezoneSettings') : undefined),
    [navigation],
  );

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
        draft={state.draft}
        reveal={state.reveal}
        submitting={state.submitting}
        error={state.error}
        status={state.status}
        onChangeDraft={onChangeDraft}
        onToggleReveal={toggleReveal}
        onRequestRemove={handleRequestRemove}
        onSave={handleSave}
        onBack={onBack}
        onOpenTimezone={onOpenTimezone}
      />
    </ScreenScaffold>
  );
}

const MENLO_MONOSPACE = 'Menlo';
const STORED_LABEL_LETTER_SPACING = 0.5;
const PROVIDER_HINT_MARGIN_TOP = 2;

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: surface.canvas,
  },
  title: { fontSize: 22, fontWeight: '700', marginBottom: SPACING.md, color: ink.primary },
  body: {
    fontSize: 14,
    color: ink.soft,
    marginBottom: SPACING.xl,
    lineHeight: 20,
  },
  storedCard: {
    borderWidth: 1,
    borderColor: surface.hairline,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.lg,
    marginBottom: SPACING.xl,
    backgroundColor: surface.raised,
  },
  storedLabel: {
    fontSize: 12,
    color: ink.muted,
    textTransform: 'uppercase',
    letterSpacing: STORED_LABEL_LETTER_SPACING,
  },
  storedValue: {
    fontSize: 18,
    fontFamily: MENLO_MONOSPACE,
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
  inputLabel: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: SPACING.sm,
    color: ink.primary,
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
  error: { color: colors.destructive.text, marginBottom: SPACING.md },
  success: { color: colors.successText, marginBottom: SPACING.md },
  button: { borderRadius: BORDER_RADIUS.md, padding: SPACING.md + 2, alignItems: 'center' },
  primaryButton: { backgroundColor: accent.primary, marginTop: SPACING.xs },
  primaryButtonText: { color: colors.text.light, fontSize: 16, fontWeight: '600' },
  destructiveButton: {
    backgroundColor: colors.destructive.background,
    borderWidth: 1,
    borderColor: colors.destructive.border,
  },
  destructiveButtonText: { color: colors.destructive.text, fontWeight: '600' },
  linkRow: { marginTop: SPACING.xl, alignItems: 'center' },
  link: { color: accent.primary, fontWeight: '600' },
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
});
