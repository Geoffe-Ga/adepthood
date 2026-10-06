/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act, fireEvent, render, within } from '@testing-library/react-native';
import { ChevronDown, ChevronRight } from 'lucide-react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import {
  HIGHER_SELF_GAIN,
  VAULT_ADDRESS_EXTRA_PARTS,
  VAULT_ADDRESS_INCOMPLETE,
  VAULT_ADDRESS_INSECURE,
  VAULT_ADDRESS_MISSING,
  VAULT_ADDRESS_NOT_FOUND,
  VAULT_ADDRESS_PRIVATE,
  VAULT_ADDRESS_UNREADABLE,
  VAULT_ADD_HEADING,
  VAULT_ADVANCED_EXPLAINER,
  VAULT_ADVANCED_LEARN_MORE,
  VAULT_ADVANCED_NOT,
  VAULT_ADVANCED_TITLE,
  VAULT_CANCEL,
  VAULT_CONNECTION_UNKNOWN,
  VAULT_CONNECT_FAILED,
  VAULT_CONNECT_INTRO,
  VAULT_DISCONNECT_BUTTON,
  VAULT_DISCONNECT_CONFIRM_BODY,
  VAULT_DISCONNECT_CONFIRM_TITLE,
  VAULT_EYEBROW,
  VAULT_FLOOR,
  VAULT_INTIMATE,
  VAULT_KEY_MISSING,
  VAULT_KEY_REFUSED,
  VAULT_KEY_SHOW,
  VAULT_LOAD_FAILED,
  VAULT_MANAGED_UNAVAILABLE_BODY,
  VAULT_MANAGED_UNKNOWN_BODY,
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
} from '../vaultCopy';
import { VAULT_RUN_YOUR_OWN_DOC_URL } from '../vaultLinks';
import VaultSettingsScreen from '../VaultSettingsScreen';

import {
  ApiError,
  vault,
  vaultActivation,
  type VaultActivation,
  type VaultConnection,
} from '@/api';
import { decorativeHidden } from '@/components/a11yHidden';
import { touchTarget } from '@/design/tokens';
import habitStyles from '@/features/Habits/Habits.styles';
import { settle } from '@/testing/asyncSettle';
import { expectNavigationOwnsTitle } from '@/testing/navigationOwnsTitle';

/**
 * The private-vault screen, now that there is something behind it.
 *
 * The promise deck is the part that must survive everything: it is the same on
 * a dead network as on a connected account, because somebody who will never run
 * a vault still has to be able to read what one is and that the app is complete
 * without one.
 *
 * The form is the part that must not leak. The key is write-only across the
 * whole seam — it goes out on one body and comes back on no response — so these
 * tests assert it appears in no rendered text, is masked until the person asks
 * to see it, and is gone from the field once it has been sent.
 *
 * The seven refusals are seven different sentences on purpose. The server judges
 * an address on its shape, on where it points, and on whether the key could
 * survive a header, and a screen that collapsed those into "something went
 * wrong" would leave a person re-pasting the same URL forever.
 *
 * The read is a three-state answer rather than a nullable one. "Nobody checked"
 * is not "nothing is connected", so a failed read says so, and a connect made
 * from that state asks before it sends -- because the thing it may be replacing
 * is precisely the thing that could not be read.
 */

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));

const mockOpenExternalUrl = jest.fn((_url: string) => Promise.resolve(true));
jest.mock('@/utils/openExternalUrl', () => ({
  openExternalUrl: (url: string) => mockOpenExternalUrl(url),
}));

jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api');
  return {
    ...actual,
    vault: { connection: jest.fn(), connect: jest.fn(), disconnect: jest.fn() },
    vaultActivation: { status: jest.fn() },
  };
});

const mockConnection = vault.connection as jest.MockedFunction<typeof vault.connection>;
const mockConnect = vault.connect as jest.MockedFunction<typeof vault.connect>;
const mockDisconnect = vault.disconnect as jest.MockedFunction<typeof vault.disconnect>;
const mockActivationStatus = vaultActivation.status as jest.MockedFunction<
  typeof vaultActivation.status
>;

const VAULT_URL = 'https://vault.example';
const REPLACEMENT_VAULT_URL = 'https://other-vault.example';
const TYPED_KEY = 'typed-vault-key-never-rendered'; // pragma: allowlist secret
const HTTP_UNPROCESSABLE = 422;
const HTTP_SERVER_ERROR = 500;

const NOT_CONNECTED: VaultConnection = { connected: false, vault_url: null };
const CONNECTED: VaultConnection = { connected: true, vault_url: VAULT_URL };
const REPLACED: VaultConnection = { connected: true, vault_url: REPLACEMENT_VAULT_URL };
// The server cannot produce this pair, but the type can, and a screen that
// read it as "nothing connected" would be inventing an answer nobody gave.
const CONNECTED_WITHOUT_ADDRESS: VaultConnection = { connected: true, vault_url: null };
const AVAILABLE_ACTIVATION: VaultActivation = {
  active: false,
  state: 'inactive',
  new_activation_available: true,
  recovery_available: false,
  retryable: false,
  failure_reason: null,
  credential_received: false,
  attested_confidential: null,
  custody_mode: null,
};

/**
 * The promise deck: copy blocks paired with the testID the screen renders them
 * in, in reading order. Rendered on every path, folded or not.
 */
const COPY_BLOCKS: [string, string][] = [
  ['vault-what-it-is', VAULT_WHAT_IT_IS],
  ['vault-higher-self-gain', HIGHER_SELF_GAIN],
  ['vault-floor', VAULT_FLOOR],
  ['vault-intimate', VAULT_INTIMATE],
];

/** What the Advanced fold holds besides the form, in reading order. */
const FOLD_BLOCKS: [string, string][] = [
  ['vault-advanced-explainer', VAULT_ADVANCED_EXPLAINER],
  ['vault-advanced-not', VAULT_ADVANCED_NOT],
  ['vault-advanced-learn-more', VAULT_ADVANCED_LEARN_MORE],
  ['vault-connect-intro', VAULT_CONNECT_INTRO],
];

/** Everything the fold hides while it is closed. */
const FOLDED_TEST_IDS = [
  'vault-advanced-body',
  ...FOLD_BLOCKS.map(([testID]) => testID),
  'vault-address-input',
  'vault-key-input',
  'connect-vault-button',
];

const TOGGLE = 'vault-advanced-toggle';

/**
 * Absence means absent, not merely hidden from assistive technology: a closed
 * fold that still rendered its form behind ``aria-hidden`` would pass a plain
 * query, so every "is not there" check here reads hidden elements too.
 */
const HIDDEN_TOO = { includeHiddenElements: true } as const;

/** Every refusal code the connect route can answer with, and its sentence. */
const REFUSALS: [string, string][] = [
  ['vault_url_unparseable', VAULT_ADDRESS_UNREADABLE],
  ['vault_url_malformed', VAULT_ADDRESS_INCOMPLETE],
  ['vault_url_forbidden_components', VAULT_ADDRESS_EXTRA_PARTS],
  ['vault_url_insecure_transport', VAULT_ADDRESS_INSECURE],
  ['vault_url_private_address', VAULT_ADDRESS_PRIVATE],
  ['vault_url_unresolvable_host', VAULT_ADDRESS_NOT_FOUND],
  ['vault_key_unusable', VAULT_KEY_REFUSED],
];

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (_value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (_value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function renderVault(connection: VaultConnection = NOT_CONNECTED) {
  mockConnection.mockResolvedValue(connection);
  const view = render(<VaultSettingsScreen />);
  await settle();
  expect(view.queryByTestId('vault-loading', HIDDEN_TOO)).toBeNull();
  return view;
}

async function renderUnreachable() {
  mockConnection.mockRejectedValue(new ApiError(HTTP_SERVER_ERROR, 'internal_error'));
  const view = render(<VaultSettingsScreen />);
  await settle();
  expect(view.getByTestId('vault-error')).toBeTruthy();
  return view;
}

type Rendered = Awaited<ReturnType<typeof renderVault>>;

/** Whether the Advanced fold says it is open. */
function foldExpanded(view: Rendered): boolean | undefined {
  return view.getByTestId(TOGGLE).props.accessibilityState?.expanded;
}

/**
 * Open the Advanced fold, which starts closed for anybody with no vault of their
 * own connected. Strict on purpose: it refuses to "open" a fold that is already
 * open, so every caller is also a check that the default is closed.
 */
function openAdvanced(view: Rendered): void {
  expect(foldExpanded(view)).toBe(false);
  fireEvent.press(view.getByTestId(TOGGLE));
  expect(foldExpanded(view)).toBe(true);
}

/** Render with nothing connected and the fold opened, for tests about the form. */
async function renderWithFormOpen(connection: VaultConnection = NOT_CONNECTED) {
  const view = await renderVault(connection);
  openAdvanced(view);
  return view;
}

/** Render a failed read and open the fold, for tests about the form. */
async function renderUnreachableWithFormOpen() {
  const view = await renderUnreachable();
  openAdvanced(view);
  return view;
}

type TreeNode = { props?: { testID?: unknown }; children?: (TreeNode | string)[] | null };

/** Every testID in the rendered tree, in reading (depth-first) order. */
function testIDsInOrder(view: Rendered): string[] {
  const walk = (node: TreeNode | TreeNode[] | string | null): string[] => {
    if (node === null || typeof node === 'string') return [];
    if (Array.isArray(node)) return node.flatMap(walk);
    const own = typeof node.props?.testID === 'string' ? [node.props.testID] : [];
    return [...own, ...(node.children ?? []).flatMap(walk)];
  };
  return walk(view.toJSON() as TreeNode | TreeNode[] | null);
}

async function submitConnection(view: Rendered, address: string, key: string): Promise<void> {
  fireEvent.changeText(view.getByTestId('vault-address-input'), address);
  fireEvent.changeText(view.getByTestId('vault-key-input'), key);
  await act(async () => {
    fireEvent.press(view.getByTestId('connect-vault-button'));
  });
}

/** How a test answers the confirmation a press may raise. */
type DialogAnswer = 'confirm' | 'cancel' | 'none';

/** What one rendered confirmation asked, read off the dialog itself. */
interface RaisedDialog {
  title: string;
  body: string;
  /** The button labels in on-screen order. */
  labels: string[];
  destructive: boolean;
}

const DIALOG_TEST_ID = 'vault-confirm-dialog';
const ANSWER_TEST_IDS: Record<Exclude<DialogAnswer, 'none'>, string> = {
  cancel: 'vault-confirm-cancel',
  confirm: 'vault-confirm-confirm',
};

/** Read the title, body, button order and confirm styling off the open dialog. */
function readDialog(view: Rendered): RaisedDialog | null {
  const dialog = view.queryByTestId(DIALOG_TEST_ID);
  if (dialog === null) return null;
  const buttonTexts = within(dialog)
    .getAllByRole('button')
    .map((button) => within(button).getByText(/./u));
  const [title, body] = within(dialog)
    .getAllByText(/./u)
    .filter((text) => !buttonTexts.includes(text))
    .map((text) => String(text.props.children));
  const confirmText = buttonTexts[buttonTexts.length - 1];
  return {
    title: title ?? '',
    body: body ?? '',
    labels: buttonTexts.map((text) => String(text.props.children)),
    destructive: confirmText?.props.style === habitStyles.discardExitText,
  };
}

/**
 * Press ``testID``, answer whatever rendered confirmation it raises, and report
 * what that dialog asked.
 *
 * The dialog is the real ``ConfirmDialog`` the screen renders (#2928), not a
 * spied ``Alert.alert``: react-native-web ships Alert as an empty method, so a
 * spy that fires the button by hand would pass while the web build does nothing.
 * ``'none'`` leaves the dialog standing, which is how a test asserts that a
 * press asked rather than acted. ``null`` says no dialog was raised at all --
 * the assertion the anti-over-confirmation cases turn on.
 */
async function pressThroughDialog(
  view: Rendered,
  testID: string,
  answer: DialogAnswer,
): Promise<RaisedDialog | null> {
  await act(async () => {
    fireEvent.press(view.getByTestId(testID));
  });
  const raised = readDialog(view);
  if (raised !== null && answer !== 'none') {
    await act(async () => {
      fireEvent.press(view.getByTestId(ANSWER_TEST_IDS[answer]));
    });
  }
  return raised;
}

/** Press disconnect and answer its confirmation. */
async function pressDisconnect(view: Rendered, answer: DialogAnswer): Promise<RaisedDialog | null> {
  return pressThroughDialog(view, 'disconnect-vault-button', answer);
}

/** Fill both fields, press Connect, and answer any confirmation that follows. */
async function pressConnectThroughDialog(
  view: Rendered,
  fields: { address: string; key: string },
  answer: DialogAnswer,
): Promise<RaisedDialog | null> {
  fireEvent.changeText(view.getByTestId('vault-address-input'), fields.address);
  fireEvent.changeText(view.getByTestId('vault-key-input'), fields.key);
  return pressThroughDialog(view, 'connect-vault-button', answer);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockActivationStatus.mockResolvedValue(AVAILABLE_ACTIVATION);
  mockConnect.mockResolvedValue(CONNECTED);
  mockDisconnect.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// The promise deck
// ---------------------------------------------------------------------------

describe('VaultSettingsScreen — rendering', () => {
  test('renders the screen scaffold', async () => {
    const { getByTestId } = await renderVault();

    expect(getByTestId('vault-settings-screen')).toBeTruthy();
  });

  test('renders the eyebrow marking the vault optional', async () => {
    const { getByText } = await renderVault();

    // The shared header upper-cases the eyebrow, so match without case.
    expect(getByText(new RegExp(`^${VAULT_EYEBROW}$`, 'iu'))).toBeTruthy();
  });

  test('leaves the title to navigation: no painted title and no header named by it', async () => {
    const view = await renderVault();

    expectNavigationOwnsTitle(view, VAULT_TITLE);
  });

  test('renders the promise inside the header block', async () => {
    const { getByTestId } = await renderVault();

    expect(within(getByTestId('vault-header')).getByText(VAULT_PROMISE)).toBeTruthy();
  });

  for (const [testID, copy] of COPY_BLOCKS) {
    test(`renders "${testID}" carrying its copy verbatim`, async () => {
      const { getByTestId } = await renderVault();

      expect(within(getByTestId(testID)).getByText(copy)).toBeTruthy();
    });
  }
});

describe('VaultSettingsScreen — managed private vault', () => {
  test('offers the optional activation from an unconnected account', async () => {
    mockConnection.mockResolvedValue(NOT_CONNECTED);
    const navigate = jest.fn();
    const view = render(<VaultSettingsScreen navigation={{ navigate }} />);
    await settle();
    expect(view.queryByTestId('vault-loading', HIDDEN_TOO)).toBeNull();

    fireEvent.press(view.getByTestId('open-vault-activation'));

    expect(navigate).toHaveBeenCalledWith('VaultActivation');
  });

  test('does not offer a second allocation when a vault is already connected', async () => {
    const view = await renderVault(CONNECTED);

    expect(view.queryByTestId('open-vault-activation', HIDDEN_TOO)).toBeNull();
  });

  test('shows the server-derived unavailable state without blocking bring-your-own-vault', async () => {
    mockActivationStatus.mockResolvedValue({
      ...AVAILABLE_ACTIVATION,
      new_activation_available: false,
    });

    const view = await renderWithFormOpen(NOT_CONNECTED);

    expect(view.getByTestId('managed-vault-unavailable')).toBeTruthy();
    expect(view.queryByTestId('open-vault-activation', HIDDEN_TOO)).toBeNull();
    expect(view.getByTestId('vault-address-input')).toBeTruthy();
  });

  test('labels an existing allocation as continuation after new activation is disabled', async () => {
    mockActivationStatus.mockResolvedValue({
      ...AVAILABLE_ACTIVATION,
      active: true,
      state: 'provisioning',
      new_activation_available: false,
    });

    const view = await renderWithFormOpen(NOT_CONNECTED);

    expect(view.getByText('Continue managed vault setup')).toBeTruthy();
    expect(view.getByText('Continue setup')).toBeTruthy();
  });

  test('does not mistake an activation-status outage for account ineligibility', async () => {
    mockActivationStatus.mockRejectedValue(new Error('offline'));

    const view = await renderWithFormOpen(NOT_CONNECTED);

    expect(view.getByText('Managed vault availability could not be checked')).toBeTruthy();
    expect(view.getByTestId('vault-address-input')).toBeTruthy();
  });
});

describe('VaultSettingsScreen — accessibility', () => {
  test('gives the floor block accessibilityRole="text"', async () => {
    const { getByTestId } = await renderVault();

    expect(getByTestId('vault-floor').props.accessibilityRole).toBe('text');
  });

  test('does not re-announce the promise on the floor block', async () => {
    // The header already reads the promise; an explicit label repeating it here
    // would announce the same sentence twice in reading order.
    const { getByTestId } = await renderVault();

    expect(getByTestId('vault-floor').props.accessibilityLabel).toBeUndefined();
  });

  test('states its own optionality, so the floor stands alone when focused', async () => {
    const { getByTestId } = await renderVault();

    expect(getByTestId('vault-floor')).toHaveTextContent(/complete without a vault/iu);
  });
});

describe('VaultSettingsScreen — no source picker', () => {
  test('names no ingestion source', async () => {
    // There is still no capability that enumerates sources, so naming one would
    // be an offer the app cannot honour.
    const { queryByText } = await renderVault();

    expect(
      queryByText(/discord|google drive|claude conversations|recordings/iu, HIDDEN_TOO),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reading the connection
// ---------------------------------------------------------------------------

describe('VaultSettingsScreen — reading the connection', () => {
  test('shows a loading marker while the read is in flight, and drops it after', async () => {
    const gate = deferred<VaultConnection>();
    mockConnection.mockReturnValue(gate.promise);

    const { getByTestId, queryByTestId } = render(<VaultSettingsScreen />);
    expect(getByTestId('vault-loading')).toBeTruthy();

    await act(async () => {
      gate.resolve(NOT_CONNECTED);
      await gate.promise;
    });

    expect(queryByTestId('vault-loading', HIDDEN_TOO)).toBeNull();
  });

  test('offers the empty state and the form when nothing is connected', async () => {
    const { getByTestId, getByText, queryByTestId } = await renderWithFormOpen(NOT_CONNECTED);

    expect(getByText(VAULT_NONE_CONNECTED)).toBeTruthy();
    expect(getByText(VAULT_ADD_HEADING)).toBeTruthy();
    expect(getByTestId('vault-address-input')).toBeTruthy();
    expect(getByTestId('vault-key-input')).toBeTruthy();
    expect(getByTestId('connect-vault-button')).toBeTruthy();
    expect(queryByTestId('disconnect-vault-button', HIDDEN_TOO)).toBeNull();
  });

  test('names the connected vault and offers to replace or leave it', async () => {
    const { getByTestId, getByText } = await renderVault(CONNECTED);

    expect(within(getByTestId('vault-connected-card')).getByText(VAULT_URL)).toBeTruthy();
    expect(getByTestId('disconnect-vault-button')).toBeTruthy();
    expect(getByText(VAULT_REPLACE_HEADING)).toBeTruthy();
  });

  test('keeps the whole promise deck when the read fails', async () => {
    // The copy has to survive a dead network: somebody offline still deserves
    // to learn what a vault is and that the app is complete without one.
    const { getByTestId } = await renderUnreachable();

    expect(within(getByTestId('vault-error')).getByText(VAULT_LOAD_FAILED)).toBeTruthy();
    expect(within(getByTestId('vault-header')).getByText(VAULT_PROMISE)).toBeTruthy();
    for (const [testID, copy] of COPY_BLOCKS) {
      expect(within(getByTestId(testID)).getByText(copy)).toBeTruthy();
    }
  });

  test('a failed read never claims nothing is connected', async () => {
    // "Nobody could check" and "there is nothing there" are different answers,
    // and rendering the second for the first tells somebody their vault is gone.
    const view = await renderUnreachable();

    expect(view.queryByTestId('vault-none-connected', HIDDEN_TOO)).toBeNull();
    expect(
      within(view.getByTestId('vault-connection-unknown')).getByText(VAULT_CONNECTION_UNKNOWN),
    ).toBeTruthy();
    expect(view.queryByTestId('vault-connected-card', HIDDEN_TOO)).toBeNull();
    expect(within(view.getByTestId('vault-error')).getByText(VAULT_LOAD_FAILED)).toBeTruthy();
  });

  test('the unknown notice survives typing', async () => {
    // Typing clears the banner. The notice reports what the read found and so
    // must come from the connection state rather than riding on that banner.
    const view = await renderUnreachableWithFormOpen();

    fireEvent.changeText(view.getByTestId('vault-address-input'), VAULT_URL);

    expect(view.queryByTestId('vault-error', HIDDEN_TOO)).toBeNull();
    expect(view.getByTestId('vault-connection-unknown')).toBeTruthy();
  });

  test('recognizes a managed connection without claiming a live health check', async () => {
    const view = await renderVault(CONNECTED_WITHOUT_ADDRESS);

    expect(
      view.getByText(
        'A managed vault is connected to your account. This does not check whether it is reachable right now.',
      ),
    ).toBeTruthy();
    expect(view.queryByTestId('vault-connection-unknown', HIDDEN_TOO)).toBeNull();
    expect(view.queryByTestId('vault-none-connected', HIDDEN_TOO)).toBeNull();
    expect(view.queryByTestId('managed-vault-offer', HIDDEN_TOO)).toBeNull();
  });

  test('still asks before a managed connection could be replaced', async () => {
    const view = await renderWithFormOpen(CONNECTED_WITHOUT_ADDRESS);
    const raised = await pressConnectThroughDialog(
      view,
      { address: REPLACEMENT_VAULT_URL, key: TYPED_KEY },
      'none',
    );
    expect(raised?.title).toBe(VAULT_REPLACE_CONFIRM_TITLE);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  test('offers the add heading when it could not check', async () => {
    const view = await renderUnreachableWithFormOpen();

    expect(view.getByText(VAULT_ADD_HEADING)).toBeTruthy();
    expect(view.queryByText(VAULT_REPLACE_HEADING, HIDDEN_TOO)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Replacing what may already be there
// ---------------------------------------------------------------------------

describe('VaultSettingsScreen — asking before it replaces', () => {
  test('asks before replacing a connected vault', async () => {
    const view = await renderVault(CONNECTED);

    const raised = await pressConnectThroughDialog(
      view,
      { address: REPLACEMENT_VAULT_URL, key: TYPED_KEY },
      'none',
    );

    expect(raised).toEqual({
      title: VAULT_REPLACE_CONFIRM_TITLE,
      body: VAULT_REPLACE_CONFIRM_BODY,
      labels: [VAULT_CANCEL, VAULT_REPLACE_BUTTON],
      destructive: false,
    });
    expect(mockConnect).not.toHaveBeenCalled();
  });

  test('replaces once on the confirming answer', async () => {
    const view = await renderVault(CONNECTED);
    mockConnect.mockResolvedValue(REPLACED);

    const raised = await pressConnectThroughDialog(
      view,
      { address: REPLACEMENT_VAULT_URL, key: TYPED_KEY },
      'confirm',
    );

    expect(raised?.labels).toEqual([VAULT_CANCEL, VAULT_REPLACE_BUTTON]);
    expect(view.queryByTestId('vault-confirm-dialog', HIDDEN_TOO)).toBeNull();
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockConnect).toHaveBeenCalledWith({
      vault_url: REPLACEMENT_VAULT_URL,
      api_key: TYPED_KEY,
    });
    expect(
      within(view.getByTestId('vault-connected-card')).getByText(REPLACEMENT_VAULT_URL),
    ).toBeTruthy();
  });

  test('leaves the old vault and the typed key alone on cancel', async () => {
    const view = await renderVault(CONNECTED);

    const raised = await pressConnectThroughDialog(
      view,
      { address: REPLACEMENT_VAULT_URL, key: TYPED_KEY },
      'cancel',
    );

    expect(raised).not.toBeNull();
    expect(view.queryByTestId('vault-confirm-dialog', HIDDEN_TOO)).toBeNull();
    expect(mockConnect).not.toHaveBeenCalled();
    expect(within(view.getByTestId('vault-connected-card')).getByText(VAULT_URL)).toBeTruthy();
    // Nothing was sent, so nothing was cleared and nothing was re-masked.
    expect(view.getByTestId('vault-key-input').props.value).toBe(TYPED_KEY);
  });

  test('asks before connecting when it could not check', async () => {
    const view = await renderUnreachableWithFormOpen();

    const raised = await pressConnectThroughDialog(
      view,
      { address: VAULT_URL, key: TYPED_KEY },
      'confirm',
    );

    expect(raised).toEqual({
      title: VAULT_REPLACE_UNKNOWN_CONFIRM_TITLE,
      body: VAULT_REPLACE_UNKNOWN_CONFIRM_BODY,
      labels: [VAULT_CANCEL, VAULT_REPLACE_BUTTON],
      destructive: false,
    });
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  test('does not ask when the read said nothing is connected', async () => {
    // Confirming a first connection would charge every new vault a dialog for
    // a replacement that cannot be happening.
    const view = await renderWithFormOpen(NOT_CONNECTED);

    const raised = await pressConnectThroughDialog(
      view,
      { address: VAULT_URL, key: TYPED_KEY },
      'none',
    );

    expect(raised).toBeNull();
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  test('does not ask about replacing when there is nothing to send', async () => {
    const view = await renderVault(CONNECTED);

    const raised = await pressConnectThroughDialog(view, { address: '', key: TYPED_KEY }, 'none');

    expect(raised).toBeNull();
    expect(within(view.getByTestId('vault-error')).getByText(VAULT_ADDRESS_MISSING)).toBeTruthy();
    expect(mockConnect).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

describe('VaultSettingsScreen — connecting', () => {
  test('sends exactly what was typed and reports the connection it made', async () => {
    const view = await renderWithFormOpen(NOT_CONNECTED);

    await submitConnection(view, VAULT_URL, TYPED_KEY);

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockConnect).toHaveBeenCalledWith({ vault_url: VAULT_URL, api_key: TYPED_KEY });
    expect(within(view.getByTestId('vault-status')).getByText(VAULT_STATUS_CONNECTED)).toBeTruthy();
    expect(within(view.getByTestId('vault-connected-card')).getByText(VAULT_URL)).toBeTruthy();
  });

  test('asks for the address rather than sending an empty one', async () => {
    const view = await renderWithFormOpen(NOT_CONNECTED);

    await submitConnection(view, '', TYPED_KEY);

    expect(within(view.getByTestId('vault-error')).getByText(VAULT_ADDRESS_MISSING)).toBeTruthy();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  test('asks for the key rather than sending an address alone', async () => {
    const view = await renderWithFormOpen(NOT_CONNECTED);

    await submitConnection(view, VAULT_URL, '');

    expect(within(view.getByTestId('vault-error')).getByText(VAULT_KEY_MISSING)).toBeTruthy();
    expect(mockConnect).not.toHaveBeenCalled();
  });
});

describe('VaultSettingsScreen — what the server refused', () => {
  for (const [code, sentence] of REFUSALS) {
    test(`answers "${code}" with the sentence written for it`, async () => {
      mockConnect.mockRejectedValue(new ApiError(HTTP_UNPROCESSABLE, code));
      const view = await renderWithFormOpen(NOT_CONNECTED);

      await submitConnection(view, 'not-a-vault', TYPED_KEY);

      expect(within(view.getByTestId('vault-error')).getByText(sentence)).toBeTruthy();
    });
  }

  test('falls back to the generic failure for a 422 code it does not know', async () => {
    mockConnect.mockRejectedValue(new ApiError(HTTP_UNPROCESSABLE, 'vault_url_from_the_future'));
    const view = await renderWithFormOpen(NOT_CONNECTED);

    await submitConnection(view, VAULT_URL, TYPED_KEY);

    expect(within(view.getByTestId('vault-error')).getByText(VAULT_CONNECT_FAILED)).toBeTruthy();
  });

  test('falls back to the generic failure for a fault that is not a refusal', async () => {
    mockConnect.mockRejectedValue(new ApiError(HTTP_SERVER_ERROR, 'internal_error'));
    const view = await renderWithFormOpen(NOT_CONNECTED);

    await submitConnection(view, VAULT_URL, TYPED_KEY);

    expect(within(view.getByTestId('vault-error')).getByText(VAULT_CONNECT_FAILED)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Disconnecting
// ---------------------------------------------------------------------------

describe('VaultSettingsScreen — disconnecting', () => {
  test('asks before it disconnects', async () => {
    const view = await renderVault(CONNECTED);

    const raised = await pressDisconnect(view, 'none');

    expect(raised).toEqual({
      title: VAULT_DISCONNECT_CONFIRM_TITLE,
      body: VAULT_DISCONNECT_CONFIRM_BODY,
      labels: [VAULT_CANCEL, VAULT_DISCONNECT_BUTTON],
      destructive: true,
    });
    expect(mockDisconnect).not.toHaveBeenCalled();
  });

  test('disconnects once on the destructive answer and says the writing stays', async () => {
    const view = await renderVault(CONNECTED);
    mockConnection.mockResolvedValue(NOT_CONNECTED);

    await pressDisconnect(view, 'confirm');

    expect(view.queryByTestId('vault-confirm-dialog', HIDDEN_TOO)).toBeNull();
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(
      within(view.getByTestId('vault-status')).getByText(VAULT_STATUS_DISCONNECTED),
    ).toBeTruthy();
    expect(view.getByText(VAULT_NONE_CONNECTED)).toBeTruthy();
    expect(view.queryByTestId('disconnect-vault-button', HIDDEN_TOO)).toBeNull();
  });

  test('does nothing at all on cancel', async () => {
    const view = await renderVault(CONNECTED);

    const raised = await pressDisconnect(view, 'cancel');

    expect(raised).not.toBeNull();
    expect(view.queryByTestId('vault-confirm-dialog', HIDDEN_TOO)).toBeNull();
    expect(mockDisconnect).not.toHaveBeenCalled();
    expect(view.getByTestId('disconnect-vault-button')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The credential
// ---------------------------------------------------------------------------

describe('VaultSettingsScreen — the key is write-only', () => {
  test('masks the key until somebody asks to see it', async () => {
    const view = await renderWithFormOpen(NOT_CONNECTED);

    expect(view.getByTestId('vault-key-input').props.secureTextEntry).toBe(true);

    fireEvent.press(view.getByText(VAULT_KEY_SHOW));

    expect(view.getByTestId('vault-key-input').props.secureTextEntry).toBe(false);
  });

  test('renders the key nowhere, even in the sentence explaining a refusal', async () => {
    mockConnect.mockRejectedValue(new ApiError(HTTP_UNPROCESSABLE, 'vault_url_insecure_transport'));
    const view = await renderWithFormOpen(NOT_CONNECTED);

    await submitConnection(view, 'http://vault.example', TYPED_KEY);

    expect(within(view.getByTestId('vault-error')).getByText(VAULT_ADDRESS_INSECURE)).toBeTruthy();
    expect(view.queryAllByText(new RegExp(TYPED_KEY, 'u'))).toHaveLength(0);
  });

  test('clears the field once the key has been sent', async () => {
    const view = await renderWithFormOpen(NOT_CONNECTED);

    await submitConnection(view, VAULT_URL, TYPED_KEY);

    expect(view.getByTestId('vault-key-input').props.value).toBe('');
  });

  test('re-masks the key when a connect is sent', async () => {
    const view = await renderWithFormOpen(NOT_CONNECTED);
    fireEvent.press(view.getByText(VAULT_KEY_SHOW));

    await submitConnection(view, VAULT_URL, TYPED_KEY);

    expect(view.getByTestId('vault-key-input').props.secureTextEntry).toBe(true);
    expect(view.getByTestId('vault-key-input').props.value).toBe('');
  });

  test('re-masks the key when the server refuses, and keeps it to correct the address', async () => {
    // The address is the part that was wrong, so the key stays put rather than
    // making somebody fetch it again -- but it goes back behind the mask.
    mockConnect.mockRejectedValue(new ApiError(HTTP_UNPROCESSABLE, 'vault_url_malformed'));
    const view = await renderWithFormOpen(NOT_CONNECTED);
    fireEvent.press(view.getByText(VAULT_KEY_SHOW));

    await submitConnection(view, 'not-a-vault', TYPED_KEY);

    expect(view.getByTestId('vault-key-input').props.secureTextEntry).toBe(true);
    expect(view.getByTestId('vault-key-input').props.value).toBe(TYPED_KEY);
  });

  test('keeps the reveal when nothing was sent', async () => {
    // A press blocked by a blank field never reached the wire, so the reset
    // belongs to the send rather than to the button.
    const view = await renderWithFormOpen(NOT_CONNECTED);
    fireEvent.press(view.getByText(VAULT_KEY_SHOW));

    await submitConnection(view, '', TYPED_KEY);

    expect(view.getByTestId('vault-key-input').props.secureTextEntry).toBe(false);
    expect(within(view.getByTestId('vault-error')).getByText(VAULT_ADDRESS_MISSING)).toBeTruthy();
  });

  test('keeps the reveal when the replacement is cancelled', async () => {
    // The third way a press sends nothing. A blank field is caught before the
    // dialog; this one raises the dialog and is declined, so the key never
    // reached the wire and the reset that belongs to the send must not run.
    const view = await renderVault(CONNECTED);
    fireEvent.press(view.getByText(VAULT_KEY_SHOW));

    const raised = await pressConnectThroughDialog(
      view,
      { address: REPLACEMENT_VAULT_URL, key: TYPED_KEY },
      'cancel',
    );

    expect(raised).not.toBeNull();
    expect(view.getByTestId('vault-key-input').props.secureTextEntry).toBe(false);
    expect(view.getByTestId('vault-key-input').props.value).toBe(TYPED_KEY);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  test('shows the address on the connected card and nothing key-shaped', async () => {
    const view = await renderWithFormOpen(NOT_CONNECTED);

    await submitConnection(view, VAULT_URL, TYPED_KEY);

    const card = within(view.getByTestId('vault-connected-card'));
    expect(card.getByText(VAULT_URL)).toBeTruthy();
    expect(card.queryAllByText(new RegExp(TYPED_KEY, 'u'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// What saying yes gives, beside the floor (#3003)
// ---------------------------------------------------------------------------

describe('VaultSettingsScreen — the gain sits directly above the floor', () => {
  test('renders the promise deck in reading order, the floor right beneath the gain', async () => {
    const view = await renderVault(NOT_CONNECTED);
    const order = testIDsInOrder(view);
    const deck = COPY_BLOCKS.map(([testID]) => order.indexOf(testID));

    expect(deck.every((index) => index >= 0)).toBe(true);
    expect(order.indexOf('vault-floor')).toBe(order.indexOf('vault-higher-self-gain') + 1);
    expect(deck).toEqual([...deck].sort((a, b) => a - b));
  });

  test('keeps the eyebrow "Optional"', async () => {
    const { getByText } = await renderVault(NOT_CONNECTED);

    expect(getByText(/^Optional$/iu)).toBeTruthy();
  });

  test('keeps the managed custody disclosure, Creek operators and Intimate included', async () => {
    const view = await renderVault(NOT_CONNECTED);

    expect(
      within(view.getByTestId('managed-vault-offer')).getByText(
        /Fly and privileged Adepthood or Creek operators can access its stored bytes; Intimate writing stays local\./u,
      ),
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The Advanced fold (#3007)
// ---------------------------------------------------------------------------

describe('VaultSettingsScreen — the Advanced fold, closed by default', () => {
  test('folds the connect form behind a closed Advanced header when nothing is connected', async () => {
    const view = await renderVault(NOT_CONNECTED);
    const toggle = view.getByTestId(TOGGLE);

    expect(toggle.props.accessibilityRole).toBe('button');
    expect(toggle.props.accessibilityLabel).toBe(VAULT_ADVANCED_TITLE);
    expect(foldExpanded(view)).toBe(false);
    expect(within(toggle).getByText(VAULT_ADVANCED_TITLE)).toBeTruthy();
    for (const testID of FOLDED_TEST_IDS) {
      expect(view.queryByTestId(testID, HIDDEN_TOO)).toBeNull();
    }
  });

  test('keeps the read-failure line visible while the Advanced fold is closed', async () => {
    const view = await renderUnreachable();

    expect(foldExpanded(view)).toBe(false);
    expect(within(view.getByTestId('vault-error')).getByText(VAULT_LOAD_FAILED)).toBeTruthy();
    for (const testID of FOLDED_TEST_IDS) {
      expect(view.queryByTestId(testID, HIDDEN_TOO)).toBeNull();
    }
  });

  test('reads the feedback line after the fold, open or closed', async () => {
    const view = await renderUnreachable();
    const closed = testIDsInOrder(view);

    expect(closed.indexOf('vault-error')).toBeGreaterThan(closed.indexOf(TOGGLE));

    openAdvanced(view);
    const open = testIDsInOrder(view);
    expect(open.indexOf('vault-error')).toBeGreaterThan(open.indexOf('connect-vault-button'));
  });

  test('keeps the unknown and empty notices outside the fold', async () => {
    const unknown = await renderUnreachable();
    const unknownOrder = testIDsInOrder(unknown);
    expect(unknownOrder.indexOf('vault-connection-unknown')).toBeLessThan(
      unknownOrder.indexOf(TOGGLE),
    );
    unknown.unmount();

    const empty = await renderVault(NOT_CONNECTED);
    const emptyOrder = testIDsInOrder(empty);
    expect(emptyOrder.indexOf('vault-none-connected')).toBeGreaterThanOrEqual(0);
    expect(emptyOrder.indexOf('vault-none-connected')).toBeLessThan(emptyOrder.indexOf(TOGGLE));
  });

  test('hides its chevron from every reader and keeps the header named', async () => {
    const view = await renderVault(NOT_CONNECTED);

    expect(view.UNSAFE_getByType(ChevronRight).props).toMatchObject(decorativeHidden());
    expect(view.UNSAFE_queryByType(ChevronDown)).toBeNull();

    fireEvent.press(view.getByTestId(TOGGLE));

    expect(view.UNSAFE_getByType(ChevronDown).props).toMatchObject(decorativeHidden());
    expect(view.UNSAFE_queryByType(ChevronRight)).toBeNull();
  });
});

describe('VaultSettingsScreen — opening the Advanced fold', () => {
  test('reveals the explanation, the guide link, the intro and the form, in that order', async () => {
    const view = await renderVault(NOT_CONNECTED);

    openAdvanced(view);

    const body = within(view.getByTestId('vault-advanced-body'));
    for (const [testID, copy] of FOLD_BLOCKS) {
      expect(body.getByTestId(testID)).toHaveTextContent(copy);
    }
    for (const testID of ['vault-address-input', 'vault-key-input', 'connect-vault-button']) {
      expect(body.getByTestId(testID)).toBeTruthy();
    }
    const order = testIDsInOrder(view);
    const reading = [...FOLD_BLOCKS.map(([testID]) => testID), 'vault-address-input'].map(
      (testID) => order.indexOf(testID),
    );
    expect(reading).toEqual([...reading].sort((a, b) => a - b));
  });

  test('gives the header and the guide link at least the minimum touch target', async () => {
    const view = await renderVault(NOT_CONNECTED);
    openAdvanced(view);

    for (const testID of [TOGGLE, 'vault-advanced-learn-more']) {
      const style = StyleSheet.flatten(view.getByTestId(testID).props.style) ?? {};
      expect(style.minHeight).toBeGreaterThanOrEqual(touchTarget.minimum);
    }
    const link = view.getByTestId('vault-advanced-learn-more');
    expect(link.props.accessibilityRole).toBe('link');
    expect(link.props.accessibilityLabel).toBe(VAULT_ADVANCED_LEARN_MORE);
    expect(within(link).getByText(VAULT_ADVANCED_LEARN_MORE)).toBeTruthy();
    // One link, the full-size target -- not a second, one-line one inside it.
    expect(view.getAllByRole('link', HIDDEN_TOO)).toEqual([link]);
  });

  test('closes again on a second press', async () => {
    const view = await renderVault(NOT_CONNECTED);
    openAdvanced(view);

    fireEvent.press(view.getByTestId(TOGGLE));

    expect(foldExpanded(view)).toBe(false);
    expect(view.queryByTestId('vault-address-input', HIDDEN_TOO)).toBeNull();
  });

  test('opens the guide through the https-only opener, at the named docs URL', async () => {
    const view = await renderVault(NOT_CONNECTED);
    openAdvanced(view);
    const link = view.getByTestId('vault-advanced-learn-more');

    expect(link.props.accessibilityRole).toBe('link');
    fireEvent.press(link);

    expect(mockOpenExternalUrl).toHaveBeenCalledTimes(1);
    expect(mockOpenExternalUrl).toHaveBeenCalledWith(VAULT_RUN_YOUR_OWN_DOC_URL);
  });

  test('keeps the card inside the fold after a first connection, with the fold still open', async () => {
    const view = await renderWithFormOpen(NOT_CONNECTED);

    await submitConnection(view, VAULT_URL, TYPED_KEY);

    expect(foldExpanded(view)).toBe(true);
    expect(
      within(view.getByTestId('vault-advanced-body')).getByTestId('vault-connected-card'),
    ).toBeTruthy();
    expect(within(view.getByTestId('vault-status')).getByText(VAULT_STATUS_CONNECTED)).toBeTruthy();
  });
});

describe('VaultSettingsScreen — the Advanced fold with a vault of your own', () => {
  test('opens on first render, so Disconnect needs no press to find', async () => {
    const view = await renderVault(CONNECTED);

    expect(foldExpanded(view)).toBe(true);
    const body = within(view.getByTestId('vault-advanced-body'));
    expect(body.getByTestId('vault-connected-card')).toBeTruthy();
    expect(body.getByTestId('disconnect-vault-button')).toBeTruthy();
    expect(view.getAllByTestId('vault-connected-card')).toHaveLength(1);
  });

  test('still asks before replacing it from inside the fold', async () => {
    const view = await renderVault(CONNECTED);

    const raised = await pressConnectThroughDialog(
      view,
      { address: REPLACEMENT_VAULT_URL, key: TYPED_KEY },
      'none',
    );

    expect(raised?.title).toBe(VAULT_REPLACE_CONFIRM_TITLE);
    expect(view.getByTestId('vault-confirm-dialog')).toBeTruthy();
  });

  test('stays open after a disconnect, rather than resetting with the state', async () => {
    const view = await renderVault(CONNECTED);

    await pressDisconnect(view, 'confirm');

    expect(foldExpanded(view)).toBe(true);
    expect(view.getByTestId('vault-address-input')).toBeTruthy();
    expect(
      within(view.getByTestId('vault-status')).getByText(VAULT_STATUS_DISCONNECTED),
    ).toBeTruthy();
  });

  test('stays closed for a vault the read could not name', async () => {
    // A managed binding stays distinct from a user-supplied address;
    // only a vault somebody connected themselves opens the fold.
    const view = await renderVault(CONNECTED_WITHOUT_ADDRESS);

    expect(foldExpanded(view)).toBe(false);
  });
});

describe('VaultSettingsScreen — the managed offer comes before the fold', () => {
  test('renders the managed offer above the Advanced header', async () => {
    const view = await renderVault(NOT_CONNECTED);
    const order = testIDsInOrder(view);

    expect(order.indexOf('managed-vault-offer')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('managed-vault-offer')).toBeLessThan(order.indexOf(TOGGLE));
  });

  test('says where the folded form is when managed vaults are not open yet', async () => {
    mockActivationStatus.mockResolvedValue({
      ...AVAILABLE_ACTIVATION,
      new_activation_available: false,
    });
    const view = await renderVault(NOT_CONNECTED);
    const order = testIDsInOrder(view);

    expect(order.indexOf('managed-vault-unavailable')).toBeLessThan(order.indexOf(TOGGLE));
    expect(
      within(view.getByTestId('managed-vault-unavailable')).getByText(
        VAULT_MANAGED_UNAVAILABLE_BODY,
      ),
    ).toBeTruthy();
  });

  test('says where the folded form is when availability could not be checked', async () => {
    mockActivationStatus.mockRejectedValue(new Error('offline'));
    const view = await renderVault(NOT_CONNECTED);
    const order = testIDsInOrder(view);

    expect(order.indexOf('managed-vault-unavailable')).toBeLessThan(order.indexOf(TOGGLE));
    expect(
      within(view.getByTestId('managed-vault-unavailable')).getByText(VAULT_MANAGED_UNKNOWN_BODY),
    ).toBeTruthy();
  });

  test('never points "below" without naming the Advanced section', async () => {
    mockActivationStatus.mockResolvedValue({
      ...AVAILABLE_ACTIVATION,
      new_activation_available: false,
    });
    const view = await renderVault(NOT_CONNECTED);

    for (const node of view.queryAllByText(/below/u)) {
      expect(node).toHaveTextContent(/under Advanced, below/u);
    }
  });
});

describe('VaultSettingsScreen — the fold is remembered for this visit only', () => {
  test('the screen persists nothing about it', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'features', 'Settings', 'VaultSettingsScreen.tsx'),
      'utf8',
    );

    expect(source).not.toMatch(/AsyncStorage|SecureStore|localStorage/u);
  });

  test('a fresh visit starts closed again', async () => {
    const first = await renderVault(NOT_CONNECTED);
    openAdvanced(first);
    first.unmount();

    const second = await renderVault(NOT_CONNECTED);

    expect(foldExpanded(second)).toBe(false);
  });
});
