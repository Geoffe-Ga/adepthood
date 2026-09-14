import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { vaultActivation, type VaultActivation } from '@/api';
import { Button } from '@/components/Button';
import { ScreenHeader } from '@/components/layout/ScreenHeader';
import { ScreenScaffold } from '@/components/layout/ScreenScaffold';
import { BORDER_RADIUS, SPACING, accent, colors, ink, rhythm, surface } from '@/design/tokens';

const POLL_INTERVAL_MS = 2_000;
const POLLABLE_STATES = new Set<VaultActivation['state']>([
  'submitting',
  'pending',
  'provisioning',
  'awaiting_handoff',
]);

interface Props {
  navigation?: { goBack?: () => void };
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

function progressCopy(state: VaultActivation['state']): string {
  switch (state) {
    case 'submitting':
      return 'Sending your activation request…';
    case 'pending':
      return 'Your managed space is waiting for capacity…';
    case 'provisioning':
      return 'Creek is preparing your managed space…';
    case 'awaiting_handoff':
      return 'Your encrypted vault connection is being delivered…';
    default:
      return 'Checking your managed vault…';
  }
}

const CustodyNotice = (): React.JSX.Element => (
  <View style={styles.notice} testID="activation-custody-notice">
    <Text style={styles.noticeTitle}>Provider-managed custody</Text>
    <Text style={styles.body}>
      Ordinary Fly storage is encrypted with provider-managed keys. Fly and a sufficiently
      privileged Adepthood or Creek operator can access stored bytes. This is not confidential
      compute.
    </Text>
    <Text style={styles.body}>
      INTIMATE entries stay in Adepthood and are never sent to this managed vault or a cloud
      language model. Activating it does not change that boundary.
    </Text>
  </View>
);

const Intro = ({ onContinue, onCancel }: { onContinue: () => void; onCancel: () => void }) => (
  <View testID="activation-intro">
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
        accessibilityLabel="Not now, return to Creek vault settings"
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
      Creek will create one Fly app, machine, and volume for this account. Provider-managed keys
      unlock it after unattended restarts; Adepthood will not ask you to create or store unlock
      material.
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
      <Text style={styles.body}>You can keep journaling while this finishes.</Text>
    </View>
  </View>
);

function readyCustodyCopy(custodyMode: VaultActivation['custody_mode']): string {
  if (custodyMode === 'provider_managed') {
    return 'Storage is encrypted with provider-managed keys. Fly and a sufficiently privileged operator can access stored bytes.';
  }
  if (custodyMode === 'wrapped_artifact_only') {
    return 'This legacy allocation predates the current custody contract. Its old wrapped artifact never controlled Fly storage, so no user-held recovery claim applies.';
  }
  return 'Custody details are unavailable, so Adepthood makes no confidentiality claim for this allocation.';
}

const Ready = ({ activation }: { activation: VaultActivation }): React.JSX.Element => (
  <View style={styles.readyCard} testID="activation-ready">
    <Text style={styles.sectionTitle}>Your managed vault is ready.</Text>
    <Text style={styles.body}>{readyCustodyCopy(activation.custody_mode)}</Text>
    <Text style={styles.body}>
      This is not confidential compute. INTIMATE entries remain in Adepthood and are skipped by the
      managed vault.
    </Text>
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
    <Text style={styles.sectionTitle}>Your managed vault is not ready yet.</Text>
    <Text style={styles.body}>
      Your journal still works. INTIMATE entries still stay in Adepthood and out of the managed
      vault.
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

const ManagedVaultUnavailable = ({ onBack }: { onBack: () => void }): React.JSX.Element => (
  <View style={styles.card} testID="managed-vault-unavailable" accessibilityRole="summary">
    <Text style={styles.sectionTitle}>
      Managed vault creation is not available for this account yet.
    </Text>
    <Text style={styles.body}>
      We are opening managed vaults gradually. Your journal is complete without it, and you can
      still connect a vault you run from Managed vault settings.
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

interface ActivationController extends StatusControl {
  introComplete: boolean;
  setIntroComplete: Dispatch<SetStateAction<boolean>>;
  busy: boolean;
  formError: string | null;
  start: () => Promise<void>;
  retry: () => Promise<void>;
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
        busy={controller.busy}
        error={controller.formError}
        onRetry={() => void controller.retry()}
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
        title="Create your managed vault"
        lead="An account-scoped managed cloud vault, activated only when you choose."
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

export default PrivateVaultActivationScreen;
