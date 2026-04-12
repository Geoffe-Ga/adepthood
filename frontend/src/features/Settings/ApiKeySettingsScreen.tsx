import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { useApiKey } from '@/context/ApiKeyContext';

/**
 * BYOK ("Bring Your Own Key") settings for BotMason chat.
 *
 * Lets a user paste an OpenAI or Anthropic API key that is stored **only on
 * their device** via SecureStore and is attached per-request to
 * ``/journal/chat`` via the ``X-LLM-API-Key`` header (issue #185). The key is
 * never uploaded to the backend database and is masked by default — reveal
 * toggles only show the value locally in this screen.
 */

const OPENAI_PREFIX = 'sk-';
const ANTHROPIC_PREFIX = 'sk-ant-';
const MAX_KEY_LENGTH = 256;
const MIN_KEY_LENGTH = 10;
const PLACEHOLDER_KEY = 'sk-... or sk-ant-...';
const MASK_VISIBLE_CHARS = 4;

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
  if (!key.startsWith(OPENAI_PREFIX) && !key.startsWith(ANTHROPIC_PREFIX)) {
    return {
      code: 'bad_prefix',
      message: `API keys start with "${OPENAI_PREFIX}" (OpenAI) or "${ANTHROPIC_PREFIX}" (Anthropic).`,
    };
  }
  return null;
}

function maskKey(key: string): string {
  if (key.length <= MASK_VISIBLE_CHARS * 2) return '••••••••';
  return `${key.slice(0, MASK_VISIBLE_CHARS)}••••${key.slice(-MASK_VISIBLE_CHARS)}`;
}

interface Props {
  navigation?: { goBack?: () => void };
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
}

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
}: ScreenBodyProps): React.JSX.Element => (
  <>
    <Text style={styles.title}>BotMason API Key</Text>
    <Text style={styles.body}>
      Bring your own OpenAI or Anthropic API key. It is stored only on this device and sent with
      every BotMason request via the X-LLM-API-Key header. We never upload it to our servers.
    </Text>

    {apiKey ? (
      <StoredKeyCard apiKey={apiKey} disabled={submitting} onRequestRemove={onRequestRemove} />
    ) : (
      <Text style={styles.hint} testID="no-key-hint">
        No key saved yet. BotMason will use the shared server key if one is configured.
      </Text>
    )}

    <Text style={styles.inputLabel}>{apiKey ? 'Replace key' : 'Add your key'}</Text>
    <KeyInputRow
      draft={draft}
      reveal={reveal}
      onChangeText={onChangeDraft}
      onToggleReveal={onToggleReveal}
    />

    <FeedbackBanner error={error} status={status} />

    <TouchableOpacity
      onPress={onSave}
      style={[styles.button, styles.primaryButton]}
      disabled={submitting}
      testID="save-key-button"
    >
      <Text style={styles.primaryButtonText}>{submitting ? 'Saving…' : 'Save key'}</Text>
    </TouchableOpacity>

    {onBack && (
      <TouchableOpacity onPress={onBack} style={styles.linkRow}>
        <Text style={styles.link}>Back</Text>
      </TouchableOpacity>
    )}
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

  if (isLoading) {
    return (
      <View style={styles.loadingContainer} testID="api-key-loading">
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
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
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, backgroundColor: '#fff', flexGrow: 1 },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  title: { fontSize: 22, fontWeight: '700', marginBottom: 12 },
  body: { fontSize: 14, color: '#444', marginBottom: 20, lineHeight: 20 },
  storedCard: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 12,
    padding: 16,
    marginBottom: 24,
    backgroundColor: '#fafafa',
  },
  storedLabel: { fontSize: 12, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5 },
  storedValue: {
    fontSize: 18,
    fontFamily: 'Menlo',
    marginTop: 8,
    marginBottom: 16,
    color: '#222',
  },
  hint: { fontSize: 14, color: '#666', marginBottom: 24, fontStyle: 'italic' },
  inputLabel: { fontSize: 14, fontWeight: '600', marginBottom: 8, color: '#222' },
  inputRow: { flexDirection: 'row', alignItems: 'stretch', marginBottom: 12 },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
  },
  revealButton: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderLeftWidth: 0,
    borderTopRightRadius: 8,
    borderBottomRightRadius: 8,
    paddingHorizontal: 12,
    justifyContent: 'center',
    backgroundColor: '#f3f3f3',
  },
  revealButtonText: { fontSize: 14, color: '#333', fontWeight: '600' },
  error: { color: '#d32f2f', marginBottom: 12 },
  success: { color: '#2e7d32', marginBottom: 12 },
  button: { borderRadius: 8, padding: 14, alignItems: 'center' },
  primaryButton: { backgroundColor: '#4a90d9', marginTop: 4 },
  primaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  destructiveButton: { backgroundColor: '#f8e0e0', borderWidth: 1, borderColor: '#e58a8a' },
  destructiveButtonText: { color: '#b12828', fontWeight: '600' },
  linkRow: { marginTop: 24, alignItems: 'center' },
  link: { color: '#4a90d9', fontWeight: '600' },
});
