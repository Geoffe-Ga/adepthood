import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { prepareKeyCeremony, type PreparedKeyCeremony } from './keyCeremony';
import { copyRecoveryKey, saveRecoveryKeyLocally } from './saveRecoveryKey';

import { vaultActivation, type VaultActivation, type VaultKeyCeremonyChallenge } from '@/api';
import { Button } from '@/components/Button';
import { ScreenHeader } from '@/components/layout/ScreenHeader';
import { ScreenScaffold } from '@/components/layout/ScreenScaffold';
import {
  BORDER_RADIUS,
  SPACING,
  accent,
  colors,
  ink,
  rhythm,
  surface,
  touchTarget,
} from '@/design/tokens';

const POLL_INTERVAL_MS = 2_000;
const MINIMUM_PASSPHRASE_LENGTH = 12;
const POLLABLE_STATES = new Set<VaultActivation['state']>([
  'submitting',
  'pending',
  'provisioning',
  'awaiting_handoff',
]);

interface Props {
  navigation?: { goBack?: () => void };
}

interface PreparedCeremony extends PreparedKeyCeremony {
  challenge: VaultKeyCeremonyChallenge;
}

function useMountedRef(): React.RefObject<boolean> {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

function capabilityCopy(attested: boolean | null): string {
  return attested === true
    ? 'Intimate processing is available.'
    : 'Intimate processing remains unavailable because confidential compute is not verified.';
}

function progressCopy(state: VaultActivation['state']): string {
  switch (state) {
    case 'submitting':
      return 'Sending your activation request…';
    case 'pending':
      return 'Your private space is waiting for capacity…';
    case 'provisioning':
      return 'Creek is preparing your private space…';
    case 'awaiting_handoff':
      return 'Your encrypted vault connection is being delivered…';
    default:
      return 'Checking your private vault…';
  }
}

const PrivacyNotice = (): React.JSX.Element => (
  <View style={styles.notice} testID="activation-privacy-notice">
    <Text style={styles.noticeTitle}>What stays with you</Text>
    <Text style={styles.body}>
      Your passphrase and recovery key are created and used only on this device. Adepthood receives
      a wrapped, encrypted artifact—not either secret.
    </Text>
    <Text style={styles.body}>
      Intimate processing stays unavailable until confidential compute is verified. A private vault
      alone does not make that promise true.
    </Text>
  </View>
);

const Intro = ({ onContinue, onCancel }: { onContinue: () => void; onCancel: () => void }) => (
  <View testID="activation-intro">
    <PrivacyNotice />
    <Text style={styles.floor}>Adepthood is complete without a private vault.</Text>
    <View style={styles.actions}>
      <Button
        label="Continue"
        onPress={onContinue}
        testID="continue-vault-activation"
        accessibilityLabel="Continue private vault setup"
      />
      <Button
        label="Not now"
        onPress={onCancel}
        variant="tertiary"
        testID="cancel-vault-activation"
        accessibilityLabel="Not now, return to private vault settings"
      />
    </View>
  </View>
);

const ActivationConsent = ({
  busy,
  error,
  onActivate,
  onCancel,
}: {
  busy: boolean;
  error: string | null;
  onActivate: () => void;
  onCancel: () => void;
}) => (
  <View style={styles.card} testID="activation-consent">
    <Text style={styles.sectionTitle}>Keep both ways back in</Text>
    <Text style={styles.body}>
      You will choose a passphrase and receive one recovery key. If both are lost, nobody can
      recover this vault—not Adepthood and not Creek.
    </Text>
    <Text style={styles.body}>
      Creating the vault starts an allocation. You can leave while it finishes, and your journal
      remains available.
    </Text>
    {error ? (
      <Text style={styles.error} accessibilityRole="alert">
        {error}
      </Text>
    ) : null}
    <View style={styles.actions}>
      <Button
        label="Create private vault"
        onPress={onActivate}
        busy={busy}
        testID="activate-private-vault"
      />
      <Button
        label="Cancel"
        onPress={onCancel}
        variant="tertiary"
        disabled={busy}
        testID="cancel-vault-activation"
      />
    </View>
  </View>
);

interface PassphraseFormProps {
  passphrase: string;
  confirmation: string;
  busy: boolean;
  error: string | null;
  onPassphrase: (_value: string) => void;
  onConfirmation: (_value: string) => void;
  onPrepare: () => void;
}

interface SecretInputProps {
  label: string;
  value: string;
  onChange: (_value: string) => void;
  testID: string;
}

const SecretInput = ({ label, value, onChange, testID }: SecretInputProps): React.JSX.Element => (
  <>
    <Text style={styles.inputLabel}>{label}</Text>
    <TextInput
      value={value}
      onChangeText={onChange}
      secureTextEntry
      autoCapitalize="none"
      autoCorrect={false}
      textContentType="newPassword"
      accessibilityLabel={label}
      style={styles.input}
      testID={testID}
    />
  </>
);

const PassphraseForm = ({
  passphrase,
  confirmation,
  busy,
  error,
  onPassphrase,
  onConfirmation,
  onPrepare,
}: PassphraseFormProps): React.JSX.Element => (
  <View style={styles.card} testID="vault-key-ceremony">
    <Text style={styles.sectionTitle}>Create your two ways back in</Text>
    <Text style={styles.body}>
      Choose a memorable passphrase. Next, this device will show your recovery key once so you can
      store it somewhere safe.
    </Text>
    <SecretInput
      label="Private vault passphrase"
      value={passphrase}
      onChange={onPassphrase}
      testID="vault-passphrase-input"
    />
    <SecretInput
      label="Confirm private vault passphrase"
      value={confirmation}
      onChange={onConfirmation}
      testID="vault-passphrase-confirm-input"
    />
    {error ? (
      <Text style={styles.error} accessibilityRole="alert">
        {error}
      </Text>
    ) : null}
    <Button
      label="Prepare recovery key"
      onPress={onPrepare}
      busy={busy}
      testID="prepare-vault-recovery"
    />
  </View>
);

interface RecoveryCardProps {
  prepared: PreparedCeremony;
  saved: boolean;
  busy: boolean;
  feedback: string | null;
  onToggleSaved: () => void;
  onCopy: () => void;
  onSave: () => void;
  onComplete: () => void;
}

/** Keep native accessibility state and the web ARIA state in lockstep. */
export function recoveryAcknowledgementA11y(saved: boolean) {
  return {
    accessibilityRole: 'checkbox' as const,
    accessibilityState: { checked: saved },
    'aria-checked': saved,
  };
}

const RecoveryActions = ({
  saved,
  onToggleSaved,
  onCopy,
  onSave,
}: Pick<RecoveryCardProps, 'saved' | 'onToggleSaved' | 'onCopy' | 'onSave'>): React.JSX.Element => (
  <>
    <View style={styles.sideBySide}>
      <Button
        label="Copy key"
        onPress={onCopy}
        variant="secondary"
        testID="copy-vault-recovery"
        style={styles.flexButton}
      />
      <Button
        label="Save a copy"
        onPress={onSave}
        variant="secondary"
        testID="save-vault-recovery"
        style={styles.flexButton}
      />
    </View>
    <TouchableOpacity
      {...recoveryAcknowledgementA11y(saved)}
      accessibilityLabel="I stored my recovery key somewhere safe"
      onPress={onToggleSaved}
      style={styles.checkboxRow}
      testID="vault-recovery-saved"
    >
      <View style={[styles.checkbox, saved && styles.checkboxChecked]}>
        <Text style={styles.checkmark}>{saved ? '✓' : ''}</Text>
      </View>
      <Text style={styles.checkboxLabel}>I stored my recovery key somewhere safe.</Text>
    </TouchableOpacity>
  </>
);

const RecoveryCard = ({
  prepared,
  saved,
  busy,
  feedback,
  onToggleSaved,
  onCopy,
  onSave,
  onComplete,
}: RecoveryCardProps): React.JSX.Element => (
  <View style={styles.recoveryCard} testID="vault-recovery-once">
    <Text style={styles.recoveryEyebrow}>SHOWN ONCE</Text>
    <Text style={styles.sectionTitle}>Store your recovery key now</Text>
    <Text style={styles.body}>
      After you finish this step, Adepthood cannot show this key again. Keep it apart from your
      passphrase.
    </Text>
    <Text selectable style={styles.recoveryCode} testID="vault-recovery-code">
      {prepared.recoveryCode}
    </Text>
    <RecoveryActions saved={saved} onToggleSaved={onToggleSaved} onCopy={onCopy} onSave={onSave} />
    {feedback ? (
      <Text style={styles.feedback} accessibilityLiveRegion="polite">
        {feedback}
      </Text>
    ) : null}
    <Button
      label="Finish private vault setup"
      onPress={onComplete}
      disabled={!saved}
      busy={busy}
      testID="complete-vault-ceremony"
    />
  </View>
);

const Progress = ({ state }: { state: VaultActivation['state'] }): React.JSX.Element => (
  <View style={styles.progressCard} testID="activation-progress" accessibilityLiveRegion="polite">
    <ActivityIndicator size="small" color={accent.primary} />
    <View style={styles.progressText}>
      <Text style={styles.sectionTitle}>{progressCopy(state)}</Text>
      <Text style={styles.body}>You can keep journaling while this finishes.</Text>
    </View>
  </View>
);

const Ready = ({ activation }: { activation: VaultActivation }): React.JSX.Element => (
  <View style={styles.readyCard} testID="activation-ready">
    <Text style={styles.sectionTitle}>Your private vault is ready.</Text>
    <Text style={styles.body}>{capabilityCopy(activation.attested_confidential)}</Text>
  </View>
);

interface FailedProps {
  retryable: boolean;
  busy: boolean;
  error: string | null;
  onRetry: () => void;
}

const Failed = ({ retryable, busy, error, onRetry }: FailedProps): React.JSX.Element => (
  <View style={styles.errorCard} testID="activation-failed">
    <Text style={styles.sectionTitle}>Your vault is not ready yet.</Text>
    <Text style={styles.body}>
      Your journal still works. No passphrase or recovery key was kept by Adepthood.
    </Text>
    {error ? (
      <Text style={styles.error} accessibilityRole="alert">
        {error}
      </Text>
    ) : null}
    {retryable ? (
      <Button
        label="Try activation again"
        onPress={onRetry}
        busy={busy}
        testID="retry-vault-activation"
      />
    ) : null}
  </View>
);

const LoadError = ({ onRetry }: { onRetry: () => void }): React.JSX.Element => (
  <View style={styles.errorCard} testID="activation-load-error">
    <Text style={styles.sectionTitle}>We could not check your vault.</Text>
    <Text style={styles.body}>Your journal still works. Check your connection and try again.</Text>
    <Button label="Check again" onPress={onRetry} testID="reload-vault-activation" />
  </View>
);

type MountedRef = React.RefObject<boolean>;
type SetActivation = Dispatch<SetStateAction<VaultActivation | null>>;

interface StatusControl {
  activation: VaultActivation | null;
  setActivation: SetActivation;
  loadError: boolean;
  loadStatus: () => Promise<void>;
}

function useActivationStatus(mounted: MountedRef): StatusControl {
  const [activation, setActivation] = useState<VaultActivation | null>(null);
  const [loadError, setLoadError] = useState(false);
  const loadStatus = useCallback(async () => {
    setLoadError(false);
    try {
      const next = await vaultActivation.status();
      if (mounted.current) setActivation(next);
    } catch {
      if (mounted.current) setLoadError(true);
    }
  }, [mounted]);
  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);
  useEffect(() => {
    if (!activation || !POLLABLE_STATES.has(activation.state)) return undefined;
    const timer = setTimeout(() => void loadStatus(), POLL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [activation, loadStatus]);
  return { activation, setActivation, loadError, loadStatus };
}

function useActivationCommands(
  mounted: MountedRef,
  setActivation: SetActivation,
  setBusy: Dispatch<SetStateAction<boolean>>,
  setError: Dispatch<SetStateAction<string | null>>,
): { start: () => Promise<void>; retry: () => Promise<void> } {
  const run = useCallback(
    async (operation: () => Promise<VaultActivation>, failure: string) => {
      setBusy(true);
      setError(null);
      try {
        const next = await operation();
        if (mounted.current) setActivation(next);
      } catch {
        if (mounted.current) setError(failure);
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [mounted, setActivation, setBusy, setError],
  );
  const start = useCallback(
    () =>
      run(
        () => vaultActivation.activate(),
        'We could not start the vault. Your journal still works.',
      ),
    [run],
  );
  const retry = useCallback(
    () =>
      run(() => vaultActivation.retry(), 'The retry did not reach Creek. Try again when ready.'),
    [run],
  );
  return { start, retry };
}

interface PreparationControl {
  passphrase: string;
  confirmation: string;
  prepared: PreparedCeremony | null;
  setPassphrase: Dispatch<SetStateAction<string>>;
  setConfirmation: Dispatch<SetStateAction<string>>;
  setPrepared: Dispatch<SetStateAction<PreparedCeremony | null>>;
  prepare: () => Promise<void>;
}

function useCeremonyPreparation(
  mounted: MountedRef,
  setBusy: Dispatch<SetStateAction<boolean>>,
  setError: Dispatch<SetStateAction<string | null>>,
): PreparationControl {
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [prepared, setPrepared] = useState<PreparedCeremony | null>(null);
  const prepare = useCallback(async () => {
    if (passphrase.length < MINIMUM_PASSPHRASE_LENGTH) {
      setError('Use at least 12 characters for your passphrase.');
      return;
    }
    if (passphrase !== confirmation) {
      setError('Those passphrases do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const challenge = await vaultActivation.keyCeremony();
      const result = await prepareKeyCeremony(challenge, passphrase);
      if (mounted.current) setPrepared({ ...result, challenge });
    } catch {
      if (mounted.current) setError('The recovery key could not be prepared. Try again.');
    } finally {
      if (mounted.current) {
        setPassphrase('');
        setConfirmation('');
        setBusy(false);
      }
    }
  }, [confirmation, mounted, passphrase, setBusy, setError]);
  return {
    passphrase,
    confirmation,
    prepared,
    setPassphrase,
    setConfirmation,
    setPrepared,
    prepare,
  };
}

interface SharingControl {
  feedback: string | null;
  clearFeedback: () => void;
  copy: () => Promise<void>;
  save: () => Promise<void>;
}

function useRecoverySharing(
  mounted: MountedRef,
  prepared: PreparedCeremony | null,
): SharingControl {
  const [feedback, setFeedback] = useState<string | null>(null);
  const copy = useCallback(async () => {
    if (!prepared) return;
    const copied = await copyRecoveryKey(prepared.recoveryCode);
    if (mounted.current) setFeedback(copied ? 'Recovery key copied.' : 'Copy is unavailable here.');
  }, [mounted, prepared]);
  const save = useCallback(async () => {
    if (!prepared) return;
    const saved = await saveRecoveryKeyLocally(prepared.recoveryCode);
    if (mounted.current) {
      setFeedback(saved ? 'A recovery copy was offered to your device.' : 'No copy was saved.');
    }
  }, [mounted, prepared]);
  const clearFeedback = useCallback(() => setFeedback(null), []);
  return { feedback, clearFeedback, copy, save };
}

function ceremonySubmission(prepared: PreparedCeremony) {
  return {
    protocol_version: '1.0.0' as const,
    ceremony_id: prepared.challenge.ceremony_id,
    server_nonce: prepared.challenge.server_nonce,
    recovery_saved: true as const,
    wrapped_artifact: prepared.wrappedArtifact,
    attestation: null,
    key_release: null,
  };
}

interface CompletionOptions {
  mounted: MountedRef;
  prepared: PreparedCeremony | null;
  recoverySaved: boolean;
  setPrepared: Dispatch<SetStateAction<PreparedCeremony | null>>;
  setActivation: SetActivation;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
  resetSaved: () => void;
  clearFeedback: () => void;
}

function useCeremonyCompletion(options: CompletionOptions): () => Promise<void> {
  const {
    mounted,
    prepared,
    recoverySaved,
    setPrepared,
    setActivation,
    setBusy,
    setError,
    resetSaved,
    clearFeedback,
  } = options;
  return useCallback(async () => {
    if (!prepared || !recoverySaved) return;
    setBusy(true);
    setPrepared(null);
    resetSaved();
    clearFeedback();
    try {
      const next = await vaultActivation.completeCeremony(ceremonySubmission(prepared));
      if (mounted.current) setActivation(next);
    } catch {
      if (mounted.current) {
        setError('The wrapped key was not accepted. Prepare a new recovery key to try again.');
        setActivation({ ...AWAITING_CEREMONY_STATE });
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [
    clearFeedback,
    mounted,
    prepared,
    recoverySaved,
    resetSaved,
    setActivation,
    setBusy,
    setError,
    setPrepared,
  ]);
}

interface ActivationController extends StatusControl, PreparationControl, SharingControl {
  introComplete: boolean;
  setIntroComplete: Dispatch<SetStateAction<boolean>>;
  recoverySaved: boolean;
  toggleRecoverySaved: () => void;
  busy: boolean;
  formError: string | null;
  start: () => Promise<void>;
  retry: () => Promise<void>;
  complete: () => Promise<void>;
}

function useActivationController(): ActivationController {
  const mounted = useMountedRef();
  const status = useActivationStatus(mounted);
  const [introComplete, setIntroComplete] = useState(false);
  const [recoverySaved, setRecoverySaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const preparation = useCeremonyPreparation(mounted, setBusy, setFormError);
  const sharing = useRecoverySharing(mounted, preparation.prepared);
  const commands = useActivationCommands(mounted, status.setActivation, setBusy, setFormError);
  const resetSaved = useCallback(() => setRecoverySaved(false), []);
  const toggleRecoverySaved = useCallback(() => setRecoverySaved((current) => !current), []);
  const complete = useCeremonyCompletion({
    mounted,
    prepared: preparation.prepared,
    recoverySaved,
    setPrepared: preparation.setPrepared,
    setActivation: status.setActivation,
    setBusy,
    setError: setFormError,
    resetSaved,
    clearFeedback: sharing.clearFeedback,
  });
  return {
    ...status,
    ...preparation,
    ...sharing,
    ...commands,
    introComplete,
    setIntroComplete,
    recoverySaved,
    toggleRecoverySaved,
    busy,
    formError,
    complete,
  };
}

const CeremonyContent = ({
  controller,
}: {
  controller: ActivationController;
}): React.JSX.Element => {
  if (controller.prepared) {
    return (
      <RecoveryCard
        prepared={controller.prepared}
        saved={controller.recoverySaved}
        busy={controller.busy}
        feedback={controller.feedback}
        onToggleSaved={controller.toggleRecoverySaved}
        onCopy={() => void controller.copy()}
        onSave={() => void controller.save()}
        onComplete={() => void controller.complete()}
      />
    );
  }
  return (
    <PassphraseForm
      passphrase={controller.passphrase}
      confirmation={controller.confirmation}
      busy={controller.busy}
      error={controller.formError}
      onPassphrase={controller.setPassphrase}
      onConfirmation={controller.setConfirmation}
      onPrepare={() => void controller.prepare()}
    />
  );
};

const ActivationContent = ({
  controller,
  onCancel,
}: {
  controller: ActivationController;
  onCancel: () => void;
}): React.JSX.Element => {
  const { activation } = controller;
  if (controller.loadError) return <LoadError onRetry={() => void controller.loadStatus()} />;
  if (!activation) return <ActivityIndicator testID="activation-loading" size="large" />;
  if (activation.state === 'ready') return <Ready activation={activation} />;
  if (activation.state === 'failed') {
    return (
      <Failed
        retryable={activation.retryable}
        busy={controller.busy}
        error={controller.formError}
        onRetry={() => void controller.retry()}
      />
    );
  }
  if (activation.state === 'awaiting_key_ceremony')
    return <CeremonyContent controller={controller} />;
  if (POLLABLE_STATES.has(activation.state)) return <Progress state={activation.state} />;
  if (!controller.introComplete) {
    return <Intro onContinue={() => controller.setIntroComplete(true)} onCancel={onCancel} />;
  }
  return (
    <ActivationConsent
      busy={controller.busy}
      error={controller.formError}
      onActivate={() => void controller.start()}
      onCancel={onCancel}
    />
  );
};

const PrivateVaultActivationScreen = ({ navigation }: Props): React.JSX.Element => {
  const controller = useActivationController();
  const goBack = useCallback(() => navigation?.goBack?.(), [navigation]);
  return (
    <ScreenScaffold scroll testID="private-vault-activation-screen">
      <ScreenHeader
        eyebrow="Optional privacy"
        title="Create your private vault"
        lead="A space you control, opened only when you choose."
      />
      <View style={styles.content}>
        <ActivationContent controller={controller} onCancel={goBack} />
      </View>
    </ScreenScaffold>
  );
};

const AWAITING_CEREMONY_STATE: VaultActivation = {
  active: true,
  state: 'awaiting_key_ceremony',
  retryable: false,
  failure_reason: null,
  credential_received: false,
  attested_confidential: null,
};

const styles = StyleSheet.create({
  content: { width: '100%', alignSelf: 'center' },
  notice: {
    backgroundColor: surface.sunken,
    borderRadius: BORDER_RADIUS.lg,
    borderWidth: 1,
    borderColor: surface.hairline,
    padding: SPACING.lg,
    marginBottom: rhythm.sectionGap,
  },
  noticeTitle: { color: ink.primary, fontWeight: '700', fontSize: 17, marginBottom: SPACING.sm },
  sectionTitle: { color: ink.primary, fontWeight: '700', fontSize: 20, marginBottom: SPACING.sm },
  body: { color: ink.soft, fontSize: 16, lineHeight: 24, marginBottom: SPACING.md },
  floor: {
    color: ink.primary,
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '600',
    marginBottom: rhythm.sectionGap,
  },
  card: {
    backgroundColor: surface.raised,
    borderRadius: BORDER_RADIUS.lg,
    borderWidth: 1,
    borderColor: surface.hairline,
    padding: SPACING.lg,
  },
  actions: { gap: SPACING.sm },
  inputLabel: { color: ink.primary, fontSize: 15, fontWeight: '600', marginBottom: SPACING.xs },
  input: {
    minHeight: touchTarget.minimum,
    borderWidth: 1,
    borderColor: surface.hairline,
    borderRadius: BORDER_RADIUS.md,
    paddingHorizontal: SPACING.md,
    fontSize: 16,
    color: ink.primary,
    backgroundColor: surface.canvas,
    marginBottom: SPACING.md,
  },
  error: { color: colors.destructive.text, fontSize: 15, lineHeight: 22, marginBottom: SPACING.md },
  recoveryCard: {
    backgroundColor: surface.raised,
    borderRadius: BORDER_RADIUS.lg,
    borderWidth: 2,
    borderColor: accent.primary,
    padding: SPACING.lg,
  },
  recoveryEyebrow: {
    color: accent.primary,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.5,
    marginBottom: SPACING.sm,
  },
  recoveryCode: {
    backgroundColor: surface.sunken,
    borderRadius: BORDER_RADIUS.md,
    color: ink.primary,
    fontFamily: 'monospace',
    fontSize: 16,
    lineHeight: 26,
    padding: SPACING.md,
    marginBottom: SPACING.md,
  },
  sideBySide: { flexDirection: 'row', gap: SPACING.sm, marginBottom: SPACING.sm },
  flexButton: { flex: 1, paddingHorizontal: SPACING.sm },
  feedback: { color: ink.soft, fontSize: 14, lineHeight: 21, marginBottom: SPACING.sm },
  checkboxRow: {
    minHeight: touchTarget.minimum,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: SPACING.md,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: BORDER_RADIUS.xs,
    borderWidth: 2,
    borderColor: accent.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: SPACING.sm,
  },
  checkboxChecked: { backgroundColor: accent.primary },
  checkmark: { color: accent.onPrimary, fontSize: 16, fontWeight: '700' },
  checkboxLabel: { flex: 1, color: ink.primary, fontSize: 16, lineHeight: 23 },
  progressCard: {
    backgroundColor: surface.raised,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.lg,
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderWidth: 1,
    borderColor: surface.hairline,
  },
  progressText: { flex: 1, marginLeft: SPACING.md },
  readyCard: {
    backgroundColor: surface.sunken,
    borderRadius: BORDER_RADIUS.lg,
    borderWidth: 1,
    borderColor: accent.primary,
    padding: SPACING.lg,
  },
  errorCard: {
    backgroundColor: colors.destructive.background,
    borderRadius: BORDER_RADIUS.lg,
    borderWidth: 1,
    borderColor: colors.destructive.border,
    padding: SPACING.lg,
  },
});

export default PrivateVaultActivationScreen;
