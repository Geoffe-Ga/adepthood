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
 * and never echoed into a status line, a refusal or the connected card. The
 * field is cleared as soon as a connection has been *accepted*, and the reveal
 * is dropped on every send — but a refused key is deliberately kept, behind the
 * mask, so the address can be corrected without fetching it again. Most
 * refusals on this seam are about the address, and clearing the key on those
 * would charge a re-paste for every typo.
 *
 * **The address is judged by the server alone.** This screen checks only that
 * the two fields are non-empty; every verdict on an address — on its shape, and
 * on where it points — comes back as one of seven codes, which is why there are
 * seven different sentences rather than one "something went wrong". A screen
 * that collapsed them would leave somebody re-pasting the same address forever.
 *
 * **What the read found is a three-state answer.** A read that failed is not a
 * report that nothing is attached, so the screen says so and a connect made
 * from that state asks before it sends. See ``vaultConnectionState``.
 */
import React, { useCallback, useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
  ActivityIndicator,
  Alert,
  type AlertButton,
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
  CONNECTION_UNKNOWN,
  NOTHING_CONNECTED,
  readConnectionState,
  type VaultConnectionState,
} from './vaultConnectionState';
import {
  VAULT_ADDRESS_EXTRA_PARTS,
  VAULT_ADDRESS_INCOMPLETE,
  VAULT_ADDRESS_INSECURE,
  VAULT_ADDRESS_LABEL,
  VAULT_ADDRESS_MISSING,
  VAULT_ADDRESS_NOT_FOUND,
  VAULT_ADDRESS_PLACEHOLDER,
  VAULT_ADDRESS_PRIVATE,
  VAULT_ADDRESS_UNREADABLE,
  VAULT_ADD_HEADING,
  VAULT_CANCEL,
  VAULT_CONNECTED_LABEL,
  VAULT_CONNECTING_BUTTON,
  VAULT_CONNECTION_UNKNOWN,
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
  VAULT_KEY_REFUSED,
  VAULT_KEY_SHOW,
  VAULT_LOAD_FAILED,
  VAULT_NONE_CONNECTED,
  VAULT_PROMISE,
  VAULT_REPLACE_BUTTON,
  VAULT_REPLACE_CONFIRM_BODY,
  VAULT_REPLACE_CONFIRM_TITLE,
  VAULT_REPLACE_HEADING,
  VAULT_REPLACE_UNKNOWN_CONFIRM_BODY,
  VAULT_REPLACE_UNKNOWN_CONFIRM_TITLE,
  VAULT_STATUS_CONNECTED,
  VAULT_STATUS_DISCONNECTED,
  VAULT_TITLE,
  VAULT_WHAT_IT_IS,
} from './vaultCopy';

import { ApiError, vault } from '@/api';
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

/** The status every refusal on this seam arrives with; other faults are generic. */
const HTTP_UNPROCESSABLE = 422;

/**
 * The server's refusal vocabulary, mapped to the sentence written for each.
 *
 * Kept beside the screen that renders them rather than in ``vaultCopy`` (which
 * the copy guards sweep as strings) or in the shared ``errorMessages`` table:
 * these seven exist to answer one endpoint, and a second home for them is a
 * second place for them to drift out of step with it.
 *
 * Three questions, asked in this order and answered by the first that fails:
 * the four verdicts on the shape of the address, then the two on where it
 * points, then the one on whether the key could survive a header at all.
 *
 * Exported for the drift guard alone -- no other caller should reach for it,
 * and the screen reaches it through ``refusalMessage``. The map mirrors a
 * vocabulary three backend modules own, and a mirror is only honest while
 * something fails when it drifts: the guard reads these keys directly and
 * fails on the day a code is added or renamed on the server, on the backend
 * pull request that does it, rather than years later on somebody's screen.
 */
export const REFUSAL_SENTENCES = new Map<string, string>([
  ['vault_url_unparseable', VAULT_ADDRESS_UNREADABLE],
  ['vault_url_malformed', VAULT_ADDRESS_INCOMPLETE],
  ['vault_url_forbidden_components', VAULT_ADDRESS_EXTRA_PARTS],
  ['vault_url_insecure_transport', VAULT_ADDRESS_INSECURE],
  ['vault_url_private_address', VAULT_ADDRESS_PRIVATE],
  ['vault_url_unresolvable_host', VAULT_ADDRESS_NOT_FOUND],
  ['vault_key_unusable', VAULT_KEY_REFUSED],
]);

/** What one confirmation dialog asks. */
interface ConfirmPrompt {
  readonly title: string;
  readonly body: string;
}

/** Leaving a vault is asked about once, and always the same way. */
const DISCONNECT_PROMPT: ConfirmPrompt = {
  title: VAULT_DISCONNECT_CONFIRM_TITLE,
  body: VAULT_DISCONNECT_CONFIRM_BODY,
};

/**
 * What a connect asks before it sends, keyed on what the read established.
 *
 * A ``Map`` rather than a branch, and deliberately missing the ``none`` key: a
 * miss is the answer for a first connection, which replaces nothing and so is
 * charged no dialog. The unknown entry is the point of the whole state — the
 * read that failed may have been hiding a vault, and the only honest thing to
 * do with a binding nobody could see is to ask before overwriting it.
 */
const REPLACE_PROMPTS = new Map<VaultConnectionState['kind'], ConfirmPrompt>([
  ['connected', { title: VAULT_REPLACE_CONFIRM_TITLE, body: VAULT_REPLACE_CONFIRM_BODY }],
  [
    'unknown',
    { title: VAULT_REPLACE_UNKNOWN_CONFIRM_TITLE, body: VAULT_REPLACE_UNKNOWN_CONFIRM_BODY },
  ],
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
 * The form's heading. Only a named vault earns "Replace"; the other two states
 * get the offer, which is an imperative rather than a claim about what is
 * attached. "Replace this vault" over a read that failed would assert the very
 * thing the read could not establish.
 */
function connectHeading(state: VaultConnectionState): string {
  return state.kind === 'connected' ? VAULT_REPLACE_HEADING : VAULT_ADD_HEADING;
}

/**
 * What pressing Connect must ask first, or ``undefined`` to send straight
 * through.
 *
 * A press with a blank field is never worth a dialog: it reaches the wire on no
 * path at all, so it goes through to be refused by the field check and told
 * which one is empty.
 */
function replacementPrompt(
  state: VaultConnectionState,
  address: string,
  key: string,
): ConfirmPrompt | undefined {
  if (missingFieldMessage(address, key) !== null) return undefined;
  return REPLACE_PROMPTS.get(state.kind);
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
  state: VaultConnectionState;
  setState: Dispatch<SetStateAction<VaultConnectionState>>;
  loading: boolean;
}

/**
 * Read the connection once, on mount.
 *
 * The route answers every account rather than 404ing one that has connected
 * nothing, so a failure here is a failure to reach the server — reported as
 * such, and never as "you have no vault". The state a failure leaves behind
 * says exactly that, and it is the state the read starts in: before the answer
 * arrives, nobody has checked either.
 */
function useConnectionRead(setError: Dispatch<SetStateAction<string | null>>): ConnectionRead {
  const [state, setState] = useState<VaultConnectionState>(CONNECTION_UNKNOWN);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    void vault
      .connection()
      .then((answer) => {
        if (live) setState(readConnectionState(answer));
      })
      .catch(() => {
        if (!live) return;
        setState(CONNECTION_UNKNOWN);
        setError(VAULT_LOAD_FAILED);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [setError]);

  return { state, setState, loading };
}

interface ConnectArgs {
  form: SettingsFormState;
  secret: string;
  setSecret: Dispatch<SetStateAction<string>>;
  setReveal: Dispatch<SetStateAction<boolean>>;
  setState: Dispatch<SetStateAction<VaultConnectionState>>;
}

/**
 * Send the address and the key, then keep no more of the key than the next
 * attempt needs.
 *
 * Both values are trimmed: a pasted address or key arrives with the whitespace
 * the clipboard brought, and neither carries meaning at its edges.
 *
 * The re-mask is the first thing here rather than part of either outcome.
 * ``perform`` runs only once the field check has passed, so it marks exactly
 * the presses that put a key on the wire, and a key that has been sent has no
 * business still standing in the clear whichever way the request went. The
 * field itself is cleared only on acceptance: most refusals on this seam are
 * about the address, and clearing it on those would charge a fresh paste of the
 * key for every typo in the address.
 */
function useConnectSubmit({
  form,
  secret,
  setSecret,
  setReveal,
  setState,
}: ConnectArgs): () => Promise<void> {
  const { draft, setStatus } = form;
  const validate = useCallback(() => missingFieldMessage(draft, secret), [draft, secret]);
  const perform = useCallback(async () => {
    setReveal(false);
    const answer = await vault.connect({ vault_url: draft.trim(), api_key: secret.trim() });
    setSecret('');
    setState(readConnectionState(answer));
    setStatus(VAULT_STATUS_CONNECTED);
  }, [draft, secret, setReveal, setSecret, setState, setStatus]);
  const onError = useCallback((error: unknown) => refusalMessage(error), []);
  return useSettingsSubmit(form, { validate, perform, onError });
}

/** Detach the vault, and say what that did and did not change. */
function useDisconnectSubmit(
  form: SettingsFormState,
  setState: Dispatch<SetStateAction<VaultConnectionState>>,
): () => Promise<void> {
  const { setStatus } = form;
  const validate = useCallback(() => null, []);
  const perform = useCallback(async () => {
    await vault.disconnect();
    setState(NOTHING_CONNECTED);
    setStatus(VAULT_STATUS_DISCONNECTED);
  }, [setState, setStatus]);
  const onError = useCallback(() => VAULT_DISCONNECT_FAILED, []);
  return useSettingsSubmit(form, { validate, perform, onError });
}

interface ConfirmedActionArgs {
  /** What to ask, or ``undefined`` when this press needs no asking. */
  prompt: ConfirmPrompt | undefined;
  confirmLabel: string;
  destructive: boolean;
  onConfirm: () => Promise<void>;
}

/**
 * Ask before doing something that overwrites or undoes a binding.
 *
 * One hook for both the disconnect and the replace, because they are the same
 * gesture in different words, and two copies of a confirmation is a fix applied
 * to one of them. An absent ``prompt`` performs the action straight away:
 * whether there is anything to confirm is a fact about the data, not a second
 * code path for each caller to carry.
 *
 * The buttons are always [cancel, confirm] in that order, so the way out sits
 * in the same place on every dialog this screen raises.
 */
function useConfirmedAction({
  prompt,
  confirmLabel,
  destructive,
  onConfirm,
}: ConfirmedActionArgs): () => void {
  return useCallback(() => {
    if (prompt === undefined) {
      void onConfirm();
      return;
    }
    const confirmStyle: AlertButton['style'] = destructive ? 'destructive' : 'default';
    Alert.alert(prompt.title, prompt.body, [
      { text: VAULT_CANCEL, style: 'cancel' },
      { text: confirmLabel, style: confirmStyle, onPress: () => void onConfirm() },
    ]);
  }, [prompt, confirmLabel, destructive, onConfirm]);
}

interface VaultController {
  state: VaultConnectionState;
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

type FieldEdits = Pick<VaultController, 'onChangeAddress' | 'onChangeSecret'>;

/**
 * Typing into either field, and the one thing both do besides.
 *
 * Editing clears the feedback banner: whatever the last attempt said was about
 * the values that were there then. What the *read* found is deliberately not
 * cleared with it — a keystroke changes nothing about whether a vault is
 * attached — which is why that notice lives outside the banner.
 */
function useFieldEdits(
  form: SettingsFormState,
  setSecret: Dispatch<SetStateAction<string>>,
): FieldEdits {
  const { setDraft, setError, setStatus } = form;
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
    [setSecret, clearFeedback],
  );
  return { onChangeAddress, onChangeSecret };
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
  const { setError } = form;
  const { state, setState, loading } = useConnectionRead(setError);
  const performConnect = useConnectSubmit({ form, secret, setSecret, setReveal, setState });
  const performDisconnect = useDisconnectSubmit(form, setState);
  const onConnect = useConfirmedAction({
    prompt: replacementPrompt(state, form.draft, secret),
    confirmLabel: VAULT_REPLACE_BUTTON,
    destructive: false,
    onConfirm: performConnect,
  });
  const onRequestDisconnect = useConfirmedAction({
    prompt: DISCONNECT_PROMPT,
    confirmLabel: VAULT_DISCONNECT_BUTTON,
    destructive: true,
    onConfirm: performDisconnect,
  });
  const edits = useFieldEdits(form, setSecret);
  const onToggleReveal = useCallback(() => setReveal((previous) => !previous), []);

  return {
    state,
    loading,
    form,
    secret,
    reveal,
    onToggleReveal,
    onConnect,
    onRequestDisconnect,
    ...edits,
  };
}

interface VaultConnectionNoticeProps {
  state: VaultConnectionState;
  busy: boolean;
  onRequestDisconnect: () => void;
}

/**
 * What the read found: a card, a line, or the line that admits it does not know.
 *
 * Three states and three answers, and the third is the reason the union exists.
 * Rendering the empty state over a read that failed tells somebody who has a
 * vault that they have none, which is the worst sentence this screen could say.
 */
const VaultConnectionNotice = ({
  state,
  busy,
  onRequestDisconnect,
}: VaultConnectionNoticeProps): React.JSX.Element => {
  if (state.kind === 'connected') {
    return (
      <ConnectedVaultCard
        address={state.address}
        busy={busy}
        onRequestDisconnect={onRequestDisconnect}
      />
    );
  }
  if (state.kind === 'unknown') {
    return (
      <Text style={settingsFormStyles.body} testID="vault-connection-unknown">
        {VAULT_CONNECTION_UNKNOWN}
      </Text>
    );
  }
  return (
    <Text style={styles.empty} testID="vault-none-connected">
      {VAULT_NONE_CONNECTED}
    </Text>
  );
};

/** What the read found, plus the form, which is offered in every state. */
const VaultConnectionSection = (controller: VaultController): React.JSX.Element => {
  const { state, form } = controller;
  return (
    <>
      <VaultConnectionNotice
        state={state}
        busy={form.submitting}
        onRequestDisconnect={controller.onRequestDisconnect}
      />
      <VaultConnectForm
        heading={connectHeading(state)}
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
