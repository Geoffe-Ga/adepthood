/**
 * ``VaultSettingsScreen`` — "Your private vault", reached from the Privacy
 * group in Settings, and the only place a person can attach a space of their
 * own to their account.
 *
 * Two things live here under one promise. The deck at the top describes a vault
 * to somebody who may never run one, and it renders on every path — including a
 * dead network — because the floor it states ("Adepthood is complete without a
 * vault") is true whether or not the server answered. Below it is the form,
 * which is the part that touches a credential.
 *
 * **The key is write-only across the whole seam.** It goes out on one body and
 * comes back on no response: it is never persisted on the device, never logged,
 * never echoed into a status line, a refusal or the connected card, and the
 * field is cleared the moment it has been sent.
 *
 * **The address is judged by the server alone.** This screen checks only that
 * the two fields are non-empty; every verdict on the shape of an address comes
 * back as one of four codes, which is why there are four different sentences
 * rather than one "something went wrong". A screen that collapsed them would
 * leave somebody re-pasting the same address forever.
 */
import React, { useCallback, useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';

import { SettingsFeedbackBanner } from './shared/SettingsFeedbackBanner';
import {
  SETTINGS_BUTTON_PADDING,
  SETTINGS_CARD_LABEL_LETTER_SPACING,
  SETTINGS_MONOSPACE_FONT,
  settingsFormStyles,
} from './shared/settingsFormLayout';
import type { SettingsFormState } from './shared/useSettingsForm';
import { useSettingsFormState, useSettingsSubmit } from './shared/useSettingsForm';
import {
  VAULT_ADDRESS_EXTRA_PARTS,
  VAULT_ADDRESS_INCOMPLETE,
  VAULT_ADDRESS_INSECURE,
  VAULT_ADDRESS_LABEL,
  VAULT_ADDRESS_MISSING,
  VAULT_ADDRESS_PLACEHOLDER,
  VAULT_ADDRESS_UNREADABLE,
  VAULT_ADD_HEADING,
  VAULT_CANCEL,
  VAULT_CONNECTED_LABEL,
  VAULT_CONNECTING_BUTTON,
  VAULT_CONNECT_BUTTON,
  VAULT_CONNECT_FAILED,
  VAULT_CONNECT_INTRO,
  VAULT_DISCONNECTING_BUTTON,
  VAULT_DISCONNECT_BUTTON,
  VAULT_DISCONNECT_CONFIRM_BODY,
  VAULT_DISCONNECT_CONFIRM_TITLE,
  VAULT_DISCONNECT_FAILED,
  VAULT_EYEBROW,
  VAULT_FLOOR,
  VAULT_INTIMATE,
  VAULT_KEY_HIDE,
  VAULT_KEY_LABEL,
  VAULT_KEY_MISSING,
  VAULT_KEY_PLACEHOLDER,
  VAULT_KEY_SHOW,
  VAULT_LOAD_FAILED,
  VAULT_NONE_CONNECTED,
  VAULT_PROMISE,
  VAULT_REPLACE_HEADING,
  VAULT_STATUS_CONNECTED,
  VAULT_STATUS_DISCONNECTED,
  VAULT_TITLE,
  VAULT_WHAT_IT_IS,
} from './vaultCopy';

import { ApiError, vault, type VaultConnection } from '@/api';
import { ScreenHeader } from '@/components/layout/ScreenHeader';
import { ScreenScaffold } from '@/components/layout/ScreenScaffold';
import {
  BORDER_RADIUS,
  SPACING,
  colors,
  ink,
  rhythm,
  surface,
  touchTarget,
  type as typeRamp,
} from '@/design/tokens';

/** The status a refused address arrives with; every other fault is generic. */
const HTTP_UNPROCESSABLE = 422;

/** The state the account is in once a disconnect has been accepted. */
const NOTHING_CONNECTED: VaultConnection = { connected: false, vault_url: null };

/**
 * The server's refusal vocabulary, mapped to the sentence written for each.
 *
 * Kept beside the screen that renders them rather than in ``vaultCopy`` (which
 * the copy guards sweep as strings) or in the shared ``errorMessages`` table:
 * these four exist to answer one classifier, and a second home for them is a
 * second place for them to drift out of step with it.
 */
const REFUSAL_SENTENCES = new Map<string, string>([
  ['vault_url_unparseable', VAULT_ADDRESS_UNREADABLE],
  ['vault_url_malformed', VAULT_ADDRESS_INCOMPLETE],
  ['vault_url_forbidden_components', VAULT_ADDRESS_EXTRA_PARTS],
  ['vault_url_insecure_transport', VAULT_ADDRESS_INSECURE],
]);

/**
 * What to say about a failed connect.
 *
 * An unrecognised 422 code falls through to the generic sentence rather than
 * rendering the code: a refusal this client has not been taught yet is still
 * more likely to be worth a retry than a raw token nobody can act on.
 */
function refusalMessage(error: unknown): string {
  if (!(error instanceof ApiError) || error.status !== HTTP_UNPROCESSABLE) {
    return VAULT_CONNECT_FAILED;
  }
  return REFUSAL_SENTENCES.get(error.detail) ?? VAULT_CONNECT_FAILED;
}

/** Which field is blank, or ``null`` when both have something in them. */
function missingFieldMessage(address: string, key: string): string | null {
  if (!address.trim()) return VAULT_ADDRESS_MISSING;
  if (!key.trim()) return VAULT_KEY_MISSING;
  return null;
}

/**
 * The address of an attached vault, or ``null`` when there is none to show.
 *
 * Folds "not read yet", "read, nothing attached" and the impossible
 * connected-with-no-address into one answer, so the card, the heading and the
 * empty state all turn on a single value instead of re-deriving the same
 * condition three times.
 */
function attachedAddress(connection: VaultConnection | null): string | null {
  if (connection === null || !connection.connected) return null;
  return connection.vault_url;
}

// ---------------------------------------------------------------------------
// The deck
// ---------------------------------------------------------------------------

/** The part that renders whatever the network did. */
const VaultPromiseDeck = (): React.JSX.Element => {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  return (
    <>
      <ScreenHeader
        eyebrow={VAULT_EYEBROW}
        title={VAULT_TITLE}
        lead={VAULT_PROMISE}
        testID="vault-header"
      />
      <Text style={[t.body, styles.body]} testID="vault-what-it-is">
        {VAULT_WHAT_IT_IS}
      </Text>
      {/* No explicit label: the floor states its own optionality, and repeating
          the header's promise here would announce it twice in reading order. */}
      <Text style={[t.body, styles.body]} accessibilityRole="text" testID="vault-floor">
        {VAULT_FLOOR}
      </Text>
      <Text style={[t.caption, styles.caption]} testID="vault-intimate">
        {VAULT_INTIMATE}
      </Text>
      <Text style={[t.caption, styles.caption]} testID="vault-connect-intro">
        {VAULT_CONNECT_INTRO}
      </Text>
    </>
  );
};

// ---------------------------------------------------------------------------
// The connection
// ---------------------------------------------------------------------------

interface ConnectedVaultCardProps {
  address: string;
  busy: boolean;
  onRequestDisconnect: () => void;
}

/**
 * Where the copies go, and the way out.
 *
 * The address is shown verbatim because it is not a secret — the server hands
 * it back on every read — and in a monospace face because it is a value
 * somebody may want to compare character by character. The credential that
 * reaches it appears nowhere.
 */
const ConnectedVaultCard = ({
  address,
  busy,
  onRequestDisconnect,
}: ConnectedVaultCardProps): React.JSX.Element => (
  <View style={styles.card} testID="vault-connected-card">
    <Text style={styles.cardLabel}>{VAULT_CONNECTED_LABEL}</Text>
    <Text style={styles.cardValue}>{address}</Text>
    <TouchableOpacity
      onPress={onRequestDisconnect}
      style={[styles.button, styles.destructiveButton]}
      disabled={busy}
      testID="disconnect-vault-button"
      accessibilityRole="button"
      accessibilityLabel={VAULT_DISCONNECT_BUTTON}
      accessibilityState={{ disabled: busy, busy }}
    >
      <Text style={styles.destructiveButtonText}>
        {busy ? VAULT_DISCONNECTING_BUTTON : VAULT_DISCONNECT_BUTTON}
      </Text>
    </TouchableOpacity>
  </View>
);

interface VaultKeyFieldProps {
  secret: string;
  reveal: boolean;
  onChangeSecret: (_value: string) => void;
  onToggleReveal: () => void;
}

/**
 * The credential field and the control that unmasks it.
 *
 * Masked by default and revealed only on request: the value is pasted from
 * somewhere else, so the reveal exists to check a paste rather than to read a
 * secret back, and nothing else on the screen ever shows it.
 */
const VaultKeyField = ({
  secret,
  reveal,
  onChangeSecret,
  onToggleReveal,
}: VaultKeyFieldProps): React.JSX.Element => (
  <>
    <Text style={settingsFormStyles.inputLabel}>{VAULT_KEY_LABEL}</Text>
    <View style={styles.inputRow}>
      <TextInput
        style={[styles.input, styles.inputInRow]}
        placeholder={VAULT_KEY_PLACEHOLDER}
        value={secret}
        onChangeText={onChangeSecret}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={!reveal}
        accessibilityLabel={VAULT_KEY_LABEL}
        testID="vault-key-input"
      />
      <TouchableOpacity
        onPress={onToggleReveal}
        style={styles.revealButton}
        accessibilityRole="button"
        accessibilityLabel={reveal ? VAULT_KEY_HIDE : VAULT_KEY_SHOW}
      >
        <Text style={styles.revealButtonText}>{reveal ? VAULT_KEY_HIDE : VAULT_KEY_SHOW}</Text>
      </TouchableOpacity>
    </View>
  </>
);

interface VaultAddressFieldProps {
  address: string;
  onChangeAddress: (_value: string) => void;
}

/** Where the vault lives. Typed as an address, so none of the text helpers fire. */
const VaultAddressField = ({
  address,
  onChangeAddress,
}: VaultAddressFieldProps): React.JSX.Element => (
  <>
    <Text style={settingsFormStyles.inputLabel}>{VAULT_ADDRESS_LABEL}</Text>
    <TextInput
      style={styles.input}
      placeholder={VAULT_ADDRESS_PLACEHOLDER}
      value={address}
      onChangeText={onChangeAddress}
      autoCapitalize="none"
      autoCorrect={false}
      keyboardType="url"
      accessibilityLabel={VAULT_ADDRESS_LABEL}
      testID="vault-address-input"
    />
  </>
);

interface VaultConnectFormProps {
  heading: string;
  address: string;
  secret: string;
  reveal: boolean;
  submitting: boolean;
  error: string | null;
  status: string | null;
  onChangeAddress: (_value: string) => void;
  onChangeSecret: (_value: string) => void;
  onToggleReveal: () => void;
  onConnect: () => void;
}

/** The two fields, the feedback, and the one button that sends them. */
const VaultConnectForm = (props: VaultConnectFormProps): React.JSX.Element => (
  <View>
    <Text style={styles.formHeading} accessibilityRole="header">
      {props.heading}
    </Text>
    <VaultAddressField address={props.address} onChangeAddress={props.onChangeAddress} />
    <VaultKeyField
      secret={props.secret}
      reveal={props.reveal}
      onChangeSecret={props.onChangeSecret}
      onToggleReveal={props.onToggleReveal}
    />
    <SettingsFeedbackBanner idPrefix="vault" error={props.error} status={props.status} />
    <TouchableOpacity
      onPress={props.onConnect}
      style={settingsFormStyles.primaryButton}
      disabled={props.submitting}
      testID="connect-vault-button"
      accessibilityRole="button"
      accessibilityLabel={VAULT_CONNECT_BUTTON}
      accessibilityState={{ disabled: props.submitting, busy: props.submitting }}
    >
      <Text style={settingsFormStyles.primaryButtonText}>
        {props.submitting ? VAULT_CONNECTING_BUTTON : VAULT_CONNECT_BUTTON}
      </Text>
    </TouchableOpacity>
  </View>
);

// ---------------------------------------------------------------------------
// Reading and writing the connection
// ---------------------------------------------------------------------------

interface ConnectionRead {
  connection: VaultConnection | null;
  setConnection: Dispatch<SetStateAction<VaultConnection | null>>;
  loading: boolean;
}

/**
 * Read the connection once, on mount.
 *
 * The route answers every account rather than 404ing one that has connected
 * nothing, so a failure here is a failure to reach the server — reported as
 * such, and never as "you have no vault".
 */
function useConnectionRead(setError: Dispatch<SetStateAction<string | null>>): ConnectionRead {
  const [connection, setConnection] = useState<VaultConnection | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    void vault
      .connection()
      .then((state) => {
        if (live) setConnection(state);
      })
      .catch(() => {
        if (live) setError(VAULT_LOAD_FAILED);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [setError]);

  return { connection, setConnection, loading };
}

interface ConnectArgs {
  form: SettingsFormState;
  secret: string;
  setSecret: Dispatch<SetStateAction<string>>;
  setConnection: Dispatch<SetStateAction<VaultConnection | null>>;
}

/**
 * Send the address and the key, then forget the key.
 *
 * Both values are trimmed: a pasted address or key arrives with the whitespace
 * the clipboard brought, and neither carries meaning at its edges. The field is
 * cleared inside the same success path that records the new connection, so the
 * credential's lifetime on the device ends with the request that used it.
 */
function useConnectSubmit({
  form,
  secret,
  setSecret,
  setConnection,
}: ConnectArgs): () => Promise<void> {
  const { draft, setStatus } = form;
  const validate = useCallback(() => missingFieldMessage(draft, secret), [draft, secret]);
  const perform = useCallback(async () => {
    const state = await vault.connect({ vault_url: draft.trim(), api_key: secret.trim() });
    setSecret('');
    setConnection(state);
    setStatus(VAULT_STATUS_CONNECTED);
  }, [draft, secret, setSecret, setConnection, setStatus]);
  const onError = useCallback((error: unknown) => refusalMessage(error), []);
  return useSettingsSubmit(form, { validate, perform, onError });
}

/** Detach the vault, and say what that did and did not change. */
function useDisconnectSubmit(
  form: SettingsFormState,
  setConnection: Dispatch<SetStateAction<VaultConnection | null>>,
): () => Promise<void> {
  const { setStatus } = form;
  const validate = useCallback(() => null, []);
  const perform = useCallback(async () => {
    await vault.disconnect();
    setConnection(NOTHING_CONNECTED);
    setStatus(VAULT_STATUS_DISCONNECTED);
  }, [setConnection, setStatus]);
  const onError = useCallback(() => VAULT_DISCONNECT_FAILED, []);
  return useSettingsSubmit(form, { validate, perform, onError });
}

/** Ask before detaching: the button is destructive, so it is not the decision. */
function useDisconnectConfirmation(performDisconnect: () => Promise<void>): () => void {
  return useCallback(() => {
    Alert.alert(VAULT_DISCONNECT_CONFIRM_TITLE, VAULT_DISCONNECT_CONFIRM_BODY, [
      { text: VAULT_CANCEL, style: 'cancel' },
      {
        text: VAULT_DISCONNECT_BUTTON,
        style: 'destructive',
        onPress: () => void performDisconnect(),
      },
    ]);
  }, [performDisconnect]);
}

interface VaultController {
  connection: VaultConnection | null;
  loading: boolean;
  form: SettingsFormState;
  secret: string;
  reveal: boolean;
  onChangeAddress: (_value: string) => void;
  onChangeSecret: (_value: string) => void;
  onToggleReveal: () => void;
  onConnect: () => void;
  onRequestDisconnect: () => void;
}

/**
 * Everything the connection half of the screen renders from.
 *
 * The shared settings form holds a single draft, so the address rides in it and
 * the key gets its own state beside it. Widening the shared hook to two drafts
 * would push a credential-shaped field into the screens that have no credential.
 */
function useVaultConnection(): VaultController {
  const form = useSettingsFormState('');
  const [secret, setSecret] = useState('');
  const [reveal, setReveal] = useState(false);
  const { setDraft, setError, setStatus } = form;
  const { connection, setConnection, loading } = useConnectionRead(setError);
  const onConnect = useConnectSubmit({ form, secret, setSecret, setConnection });
  const performDisconnect = useDisconnectSubmit(form, setConnection);
  const onRequestDisconnect = useDisconnectConfirmation(performDisconnect);

  const clearFeedback = useCallback(() => {
    setError(null);
    setStatus(null);
  }, [setError, setStatus]);
  const onChangeAddress = useCallback(
    (value: string) => {
      setDraft(value);
      clearFeedback();
    },
    [setDraft, clearFeedback],
  );
  const onChangeSecret = useCallback(
    (value: string) => {
      setSecret(value);
      clearFeedback();
    },
    [clearFeedback],
  );
  const onToggleReveal = useCallback(() => setReveal((previous) => !previous), []);

  return {
    connection,
    loading,
    form,
    secret,
    reveal,
    onChangeAddress,
    onChangeSecret,
    onToggleReveal,
    onConnect,
    onRequestDisconnect,
  };
}

/** The card, the empty state, or neither — plus the form, which is always there. */
const VaultConnectionSection = (controller: VaultController): React.JSX.Element => {
  const { connection, form } = controller;
  const address = attachedAddress(connection);
  return (
    <>
      {connection !== null && address === null ? (
        <Text style={styles.empty} testID="vault-none-connected">
          {VAULT_NONE_CONNECTED}
        </Text>
      ) : null}
      {address === null ? null : (
        <ConnectedVaultCard
          address={address}
          busy={form.submitting}
          onRequestDisconnect={controller.onRequestDisconnect}
        />
      )}
      <VaultConnectForm
        heading={address === null ? VAULT_ADD_HEADING : VAULT_REPLACE_HEADING}
        address={form.draft}
        secret={controller.secret}
        reveal={controller.reveal}
        submitting={form.submitting}
        error={form.error}
        status={form.status}
        onChangeAddress={controller.onChangeAddress}
        onChangeSecret={controller.onChangeSecret}
        onToggleReveal={controller.onToggleReveal}
        onConnect={controller.onConnect}
      />
    </>
  );
};

const VaultSettingsScreen = (): React.JSX.Element => {
  const controller = useVaultConnection();
  return (
    <ScreenScaffold scroll testID="vault-settings-screen">
      <VaultPromiseDeck />
      {controller.loading ? (
        <View style={styles.loading} testID="vault-loading">
          <ActivityIndicator size="large" />
        </View>
      ) : (
        <VaultConnectionSection {...controller} />
      )}
    </ScreenScaffold>
  );
};

const styles = StyleSheet.create({
  body: {
    color: ink.primary,
    marginBottom: rhythm.sectionGap,
  },
  caption: {
    color: ink.soft,
    marginBottom: rhythm.blockGap,
  },
  loading: {
    alignItems: 'center',
    paddingVertical: rhythm.sectionGap,
  },
  empty: {
    fontSize: 14,
    color: ink.muted,
    marginBottom: SPACING.xl,
    fontStyle: 'italic',
  },
  card: {
    borderWidth: 1,
    borderColor: surface.hairline,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.lg,
    marginBottom: SPACING.xl,
    backgroundColor: surface.raised,
  },
  cardLabel: {
    fontSize: 12,
    color: ink.muted,
    textTransform: 'uppercase',
    letterSpacing: SETTINGS_CARD_LABEL_LETTER_SPACING,
  },
  cardValue: {
    fontSize: 16,
    fontFamily: SETTINGS_MONOSPACE_FONT,
    marginTop: SPACING.sm,
    marginBottom: SPACING.lg,
    color: ink.primary,
  },
  formHeading: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: SPACING.md,
    color: ink.primary,
  },
  input: {
    borderWidth: 1,
    borderColor: surface.hairline,
    borderRadius: BORDER_RADIUS.md,
    padding: SPACING.md,
    fontSize: 16,
    backgroundColor: surface.raised,
    color: ink.primary,
    marginBottom: SPACING.md,
    minHeight: touchTarget.minimum,
  },
  inputRow: { flexDirection: 'row', alignItems: 'stretch' },
  inputInRow: { flex: 1 },
  revealButton: {
    borderWidth: 1,
    borderColor: surface.hairline,
    borderLeftWidth: 0,
    borderTopRightRadius: BORDER_RADIUS.md,
    borderBottomRightRadius: BORDER_RADIUS.md,
    paddingHorizontal: SPACING.md,
    justifyContent: 'center',
    marginBottom: SPACING.md,
    backgroundColor: surface.sunken,
  },
  revealButtonText: { fontSize: 14, color: ink.primary, fontWeight: '600' },
  button: {
    borderRadius: BORDER_RADIUS.md,
    padding: SETTINGS_BUTTON_PADDING,
    alignItems: 'center',
    minHeight: touchTarget.minimum,
  },
  destructiveButton: {
    backgroundColor: colors.destructive.background,
    borderWidth: 1,
    borderColor: colors.destructive.border,
  },
  destructiveButtonText: { color: colors.destructive.text, fontWeight: '600' },
});

export default VaultSettingsScreen;
