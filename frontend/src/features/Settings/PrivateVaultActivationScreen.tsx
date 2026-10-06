import React, { useCallback, useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { HIGHER_SELF_GAIN, VAULT_SORTING_CHOICE, VAULT_TITLE } from './vaultCopy';

import { vaultActivation, type VaultActivation } from '@/api';
import { Button } from '@/components/Button';
import { ScreenHeader } from '@/components/layout/ScreenHeader';
import { ScreenScaffold } from '@/components/layout/ScreenScaffold';
import { BORDER_RADIUS, SPACING, accent, colors, ink, rhythm, surface } from '@/design/tokens';
import { useMountedRef } from '@/hooks/useMountedRef';

const POLL_INTERVAL_MS = 2_000;
const POLLABLE_STATES = new Set<VaultActivation['state']>([
  'submitting',
  'pending',
  'provisioning',
  'awaiting_handoff',
  'deleting',
]);

interface Props {
  navigation?: { goBack?: () => void };
}

function progressCopy(state: VaultActivation['state']): string {
  switch (state) {
    case 'submitting':
      return 'Sending your activation request…';
    case 'pending':
      return 'Waiting for room to open up for your vault…';
    case 'provisioning':
      return 'Your managed vault is being set up…';
    case 'awaiting_handoff':
      return 'Connecting Adepthood to your new vault…';
    case 'deleting':
      return 'Clearing away the vault that did not finish…';
    default:
      return 'Checking your managed vault…';
  }
}

function progressDetail(state: VaultActivation['state']): string {
  if (state === 'deleting') {
    return 'Secure cleanup may take up to 24 hours. You can leave this page and return later; your journal remains available.';
  }
  return 'You can keep journaling while this finishes.';
}

const CustodyNotice = (): React.JSX.Element => (
  <View style={styles.notice} testID="activation-custody-notice">
    <Text style={styles.noticeTitle}>Who can read a managed vault</Text>
    <Text style={styles.body}>
      A managed vault lives on servers run by a hosting company called Fly. It is encrypted, but Fly
      holds the keys, so Fly, and anyone with enough access at Adepthood or at Creek (the software
      behind the vault), could read what is stored there. It is not hidden from them.
    </Text>
    <Text style={styles.body}>
      Entries you mark Intimate stay in Adepthood and are never sent to a managed vault or to any
      AI. Creating a vault does not change that.
    </Text>
  </View>
);

const Intro = ({ onContinue, onCancel }: { onContinue: () => void; onCancel: () => void }) => (
  <View testID="activation-intro">
    {/* What saying yes to sorting gives, and that creating a vault is not that
        yes, before any custody mechanics (#3003). */}
    <Text style={styles.body} testID="activation-higher-self-gain">
      {HIGHER_SELF_GAIN}
    </Text>
    <Text style={styles.body} testID="activation-sorting-choice">
      {VAULT_SORTING_CHOICE}
    </Text>
    <CustodyNotice />
    <Text style={styles.floor}>Adepthood is complete without a managed vault.</Text>
    <View style={styles.actions}>
      <Button
        label="Continue"
        onPress={onContinue}
        testID="continue-vault-activation"
        accessibilityLabel="Continue managed vault setup"
      />
      <Button
        label="Not now"
        onPress={onCancel}
        variant="tertiary"
        testID="cancel-vault-activation"
        accessibilityLabel={`Not now, return to ${VAULT_TITLE}`}
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
    <Text style={styles.sectionTitle}>Create an isolated managed vault</Text>
    <Text style={styles.body}>
      Adepthood will set up a vault just for your account, on Fly's servers. The hosting company
      holds the keys that open it, so it can come back on its own after a restart, and you will
      never be asked to make or keep a key yourself.
    </Text>
    <Text style={styles.body}>
      Setting it up takes a little while. You can leave before it finishes, and your journal is here
      the whole time.
    </Text>
    {error ? (
      <Text style={styles.error} accessibilityRole="alert">
        {error}
      </Text>
    ) : null}
    <View style={styles.actions}>
      <Button
        label="Create managed vault"
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

const Progress = ({ state }: { state: VaultActivation['state'] }): React.JSX.Element => (
  <View style={styles.progressCard} testID="activation-progress" accessibilityLiveRegion="polite">
    <ActivityIndicator size="small" color={accent.primary} />
    <View style={styles.progressText}>
      <Text style={styles.sectionTitle}>{progressCopy(state)}</Text>
      <Text style={styles.body}>{progressDetail(state)}</Text>
    </View>
  </View>
);

function readyCustodyCopy(custodyMode: VaultActivation['custody_mode']): string {
  if (custodyMode === 'provider_managed') {
    return 'Your vault is locked with keys the hosting company (Fly) holds. Fly, and people with enough access at Adepthood or Creek, can read what is stored there.';
  }
  if (custodyMode === 'wrapped_artifact_only') {
    return 'This vault was set up under an older arrangement. Any key from that time never actually locked its storage, so there is no key of yours to recover.';
  }
  return 'Adepthood cannot tell right now who holds the keys to this vault, so it will not promise you anything about who can read it.';
}

const Ready = ({ activation }: { activation: VaultActivation }): React.JSX.Element => (
  <View style={styles.readyCard} testID="activation-ready">
    <Text style={styles.sectionTitle}>Your managed vault is ready.</Text>
    <Text style={styles.body}>{readyCustodyCopy(activation.custody_mode)}</Text>
    <Text style={styles.body}>
      This vault is not sealed off from the people who run it. Entries you mark Intimate stay in
      Adepthood and never go there.
    </Text>
  </View>
);

interface FailedProps {
  retryable: boolean;
  recoveryAvailable: boolean;
  busy: boolean;
  error: string | null;
  onRetry: () => void;
  onRecover: () => void;
}

const Failed = ({
  retryable,
  recoveryAvailable,
  busy,
  error,
  onRetry,
  onRecover,
}: FailedProps): React.JSX.Element => (
  <View style={styles.errorCard} testID="activation-failed">
    <Text style={styles.sectionTitle}>Your managed vault is not ready yet.</Text>
    <Text style={styles.body}>
      Your journal still works. Entries you mark Intimate still stay in Adepthood, out of the
      managed vault.
    </Text>
    {recoveryAvailable ? (
      <Text style={styles.body}>
        The vault that did not finish has to be cleared away before a fresh one is made. Nothing
        from the old one is kept or reused.
      </Text>
    ) : !retryable ? (
      <Text style={styles.body}>
        We could not clear away the unfinished vault on our own. Get in touch with support before
        trying again; nothing has been thrown out.
      </Text>
    ) : null}
    {error ? (
      <Text style={styles.error} accessibilityRole="alert">
        {error}
      </Text>
    ) : null}
    {recoveryAvailable ? (
      <Button
        label="Clean up and try again"
        onPress={onRecover}
        busy={busy}
        testID="recover-vault-activation"
      />
    ) : retryable ? (
      <Button label="Try again" onPress={onRetry} busy={busy} testID="retry-vault-activation" />
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

const ManagedVaultUnavailable = ({ onBack }: { onBack: () => void }): React.JSX.Element => (
  <View style={styles.card} testID="managed-vault-unavailable" accessibilityRole="summary">
    <Text style={styles.sectionTitle}>
      Managed vault creation is not available for this account yet.
    </Text>
    <Text style={styles.body}>
      We are opening managed vaults gradually. Your journal is complete without it, and you can
      still connect a vault you run yourself under Advanced in Where your writing lives.
    </Text>
    <Button label="Back to settings" onPress={onBack} testID="unavailable-vault-back" />
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
): { start: () => Promise<void>; retry: () => Promise<void>; recover: () => Promise<void> } {
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
      run(() => vaultActivation.retry(), 'That did not go through. Try again when you are ready.'),
    [run],
  );
  const recover = useCallback(
    () =>
      run(
        () => vaultActivation.recover(),
        'Clearing it away did not go through. Nothing has been thrown out; you can try again.',
      ),
    [run],
  );
  return { start, retry, recover };
}

interface ActivationController extends StatusControl {
  introComplete: boolean;
  setIntroComplete: Dispatch<SetStateAction<boolean>>;
  busy: boolean;
  formError: string | null;
  start: () => Promise<void>;
  retry: () => Promise<void>;
  recover: () => Promise<void>;
}

function useActivationController(): ActivationController {
  const mounted = useMountedRef();
  const status = useActivationStatus(mounted);
  const [introComplete, setIntroComplete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const commands = useActivationCommands(mounted, status.setActivation, setBusy, setFormError);
  return {
    ...status,
    ...commands,
    introComplete,
    setIntroComplete,
    busy,
    formError,
  };
}

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
        recoveryAvailable={activation.recovery_available}
        busy={controller.busy}
        error={controller.formError}
        onRetry={() => void controller.retry()}
        onRecover={() => void controller.recover()}
      />
    );
  }
  if (POLLABLE_STATES.has(activation.state)) return <Progress state={activation.state} />;
  if (!activation.active && !activation.new_activation_available) {
    return <ManagedVaultUnavailable onBack={onCancel} />;
  }
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
        eyebrow="Optional storage"
        title="Create managed vault"
        titleHidden
        lead="A managed vault in the cloud, just for your account, set up only when you choose."
      />
      <View style={styles.content}>
        <ActivationContent controller={controller} onCancel={goBack} />
      </View>
    </ScreenScaffold>
  );
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
  noticeTitle: { color: ink.primary, fontWeight: '700', fontSize: 18, marginBottom: SPACING.sm },
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
  error: { color: colors.destructive.text, fontSize: 15, lineHeight: 22, marginBottom: SPACING.md },
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

export { styles as privateVaultActivationStyles };
export default PrivateVaultActivationScreen;
