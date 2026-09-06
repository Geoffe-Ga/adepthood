/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { act, fireEvent, render, waitFor, within } from '@testing-library/react-native';
import React from 'react';
import { Alert, type AlertButton } from 'react-native';

import {
  VAULT_ADDRESS_EXTRA_PARTS,
  VAULT_ADDRESS_INCOMPLETE,
  VAULT_ADDRESS_INSECURE,
  VAULT_ADDRESS_MISSING,
  VAULT_ADDRESS_NOT_FOUND,
  VAULT_ADDRESS_PRIVATE,
  VAULT_ADDRESS_UNREADABLE,
  VAULT_ADD_HEADING,
  VAULT_CONNECTION_UNKNOWN,
  VAULT_CONNECT_FAILED,
  VAULT_CONNECT_INTRO,
  VAULT_DISCONNECT_CONFIRM_BODY,
  VAULT_DISCONNECT_CONFIRM_TITLE,
  VAULT_EYEBROW,
  VAULT_FLOOR,
  VAULT_INTIMATE,
  VAULT_KEY_MISSING,
  VAULT_KEY_REFUSED,
  VAULT_KEY_SHOW,
  VAULT_LOAD_FAILED,
  VAULT_NONE_CONNECTED,
  VAULT_PROMISE,
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
import VaultSettingsScreen from '../VaultSettingsScreen';

import { ApiError, vault, type VaultConnection } from '@/api';

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

jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api');
  return {
    ...actual,
    vault: { connection: jest.fn(), connect: jest.fn(), disconnect: jest.fn() },
  };
});

const mockConnection = vault.connection as jest.MockedFunction<typeof vault.connection>;
const mockConnect = vault.connect as jest.MockedFunction<typeof vault.connect>;
const mockDisconnect = vault.disconnect as jest.MockedFunction<typeof vault.disconnect>;

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

/** Copy blocks paired with the testID the screen renders them in. */
const COPY_BLOCKS: [string, string][] = [
  ['vault-what-it-is', VAULT_WHAT_IT_IS],
  ['vault-floor', VAULT_FLOOR],
  ['vault-intimate', VAULT_INTIMATE],
  ['vault-connect-intro', VAULT_CONNECT_INTRO],
];

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
  await waitFor(() => expect(view.queryByTestId('vault-loading')).toBeNull());
  return view;
}

async function renderUnreachable() {
  mockConnection.mockRejectedValue(new ApiError(HTTP_SERVER_ERROR, 'internal_error'));
  const view = render(<VaultSettingsScreen />);
  await waitFor(() => expect(view.getByTestId('vault-error')).toBeTruthy());
  return view;
}

type Rendered = Awaited<ReturnType<typeof renderVault>>;

async function submitConnection(view: Rendered, address: string, key: string): Promise<void> {
  fireEvent.changeText(view.getByTestId('vault-address-input'), address);
  fireEvent.changeText(view.getByTestId('vault-key-input'), key);
  await act(async () => {
    fireEvent.press(view.getByTestId('connect-vault-button'));
  });
}

/** How a test answers the confirmation a press may raise. */
type AlertAnswer = 'confirm' | 'cancel' | 'none';

/** What one raised confirmation was asked with. */
type AlertArgs = [string, string | undefined, AlertButton[] | undefined];

// Both confirmations on this screen offer [cancel, confirm] in that order, so
// the answer is chosen by position rather than by style: the connect dialog's
// affirmative button is not destructive, and picking it by style would need a
// second copy of this helper for the sake of one word.
const CANCEL_INDEX = 0;
const CONFIRM_INDEX = 1;

/**
 * Press ``testID``, answer whatever confirmation it raises, and report what it
 * was asked with.
 *
 * ``'none'`` leaves the dialog standing, which is how a test asserts that a
 * press asked rather than acted. An empty return says no dialog was raised at
 * all -- the assertion the anti-over-confirmation cases turn on.
 */
async function pressThroughAlert(
  view: Rendered,
  testID: string,
  answer: AlertAnswer,
): Promise<AlertArgs[]> {
  const raised: AlertArgs[] = [];
  const spy = jest.spyOn(Alert, 'alert').mockImplementation((title, body, buttons) => {
    raised.push([title, body, buttons]);
    if (answer === 'none') return;
    buttons?.[answer === 'cancel' ? CANCEL_INDEX : CONFIRM_INDEX]?.onPress?.();
  });
  await act(async () => {
    fireEvent.press(view.getByTestId(testID));
  });
  spy.mockRestore();
  return raised;
}

/** Press disconnect and answer its confirmation. */
async function pressDisconnect(view: Rendered, answer: AlertAnswer): Promise<void> {
  await pressThroughAlert(view, 'disconnect-vault-button', answer);
}

/** Fill both fields, press Connect, and answer any confirmation that follows. */
async function pressConnectThroughAlert(
  view: Rendered,
  fields: { address: string; key: string },
  answer: AlertAnswer,
): Promise<AlertArgs[]> {
  fireEvent.changeText(view.getByTestId('vault-address-input'), fields.address);
  fireEvent.changeText(view.getByTestId('vault-key-input'), fields.key);
  return pressThroughAlert(view, 'connect-vault-button', answer);
}

beforeEach(() => {
  jest.clearAllMocks();
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

  test('renders the title with accessibilityRole="header"', async () => {
    const { getByText } = await renderVault();

    expect(getByText(VAULT_TITLE).props.accessibilityRole).toBe('header');
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

    expect(queryByText(/discord|google drive|claude conversations|recordings/iu)).toBeNull();
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

    expect(queryByTestId('vault-loading')).toBeNull();
  });

  test('offers the empty state and the form when nothing is connected', async () => {
    const { getByTestId, getByText, queryByTestId } = await renderVault(NOT_CONNECTED);

    expect(getByText(VAULT_NONE_CONNECTED)).toBeTruthy();
    expect(getByText(VAULT_ADD_HEADING)).toBeTruthy();
    expect(getByTestId('vault-address-input')).toBeTruthy();
    expect(getByTestId('vault-key-input')).toBeTruthy();
    expect(getByTestId('connect-vault-button')).toBeTruthy();
    expect(queryByTestId('disconnect-vault-button')).toBeNull();
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

    expect(view.queryByTestId('vault-none-connected')).toBeNull();
    expect(
      within(view.getByTestId('vault-connection-unknown')).getByText(VAULT_CONNECTION_UNKNOWN),
    ).toBeTruthy();
    expect(view.queryByTestId('vault-connected-card')).toBeNull();
    expect(within(view.getByTestId('vault-error')).getByText(VAULT_LOAD_FAILED)).toBeTruthy();
  });

  test('the unknown notice survives typing', async () => {
    // Typing clears the banner. The notice reports what the read found and so
    // must come from the connection state rather than riding on that banner.
    const view = await renderUnreachable();

    fireEvent.changeText(view.getByTestId('vault-address-input'), VAULT_URL);

    expect(view.queryByTestId('vault-error')).toBeNull();
    expect(view.getByTestId('vault-connection-unknown')).toBeTruthy();
  });

  test('treats a connected answer with no address as unknown', async () => {
    const view = await renderVault(CONNECTED_WITHOUT_ADDRESS);

    expect(
      within(view.getByTestId('vault-connection-unknown')).getByText(VAULT_CONNECTION_UNKNOWN),
    ).toBeTruthy();
    expect(view.queryByTestId('vault-none-connected')).toBeNull();
  });

  test('offers the add heading when it could not check', async () => {
    const view = await renderUnreachable();

    expect(view.getByText(VAULT_ADD_HEADING)).toBeTruthy();
    expect(view.queryByText(VAULT_REPLACE_HEADING)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Replacing what may already be there
// ---------------------------------------------------------------------------

describe('VaultSettingsScreen — asking before it replaces', () => {
  test('asks before replacing a connected vault', async () => {
    const view = await renderVault(CONNECTED);

    const raised = await pressConnectThroughAlert(
      view,
      { address: REPLACEMENT_VAULT_URL, key: TYPED_KEY },
      'none',
    );

    expect(raised).toHaveLength(1);
    expect(raised[0]).toEqual([
      VAULT_REPLACE_CONFIRM_TITLE,
      VAULT_REPLACE_CONFIRM_BODY,
      expect.anything(),
    ]);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  test('replaces once on the confirming answer', async () => {
    const view = await renderVault(CONNECTED);
    mockConnect.mockResolvedValue(REPLACED);

    const raised = await pressConnectThroughAlert(
      view,
      { address: REPLACEMENT_VAULT_URL, key: TYPED_KEY },
      'confirm',
    );

    expect(raised).toHaveLength(1);
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

    await pressConnectThroughAlert(
      view,
      { address: REPLACEMENT_VAULT_URL, key: TYPED_KEY },
      'cancel',
    );

    expect(mockConnect).not.toHaveBeenCalled();
    expect(within(view.getByTestId('vault-connected-card')).getByText(VAULT_URL)).toBeTruthy();
    // Nothing was sent, so nothing was cleared and nothing was re-masked.
    expect(view.getByTestId('vault-key-input').props.value).toBe(TYPED_KEY);
  });

  test('asks before connecting when it could not check', async () => {
    const view = await renderUnreachable();

    const raised = await pressConnectThroughAlert(
      view,
      { address: VAULT_URL, key: TYPED_KEY },
      'confirm',
    );

    expect(raised).toHaveLength(1);
    expect(raised[0]).toEqual([
      VAULT_REPLACE_UNKNOWN_CONFIRM_TITLE,
      VAULT_REPLACE_UNKNOWN_CONFIRM_BODY,
      expect.anything(),
    ]);
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  test('does not ask when the read said nothing is connected', async () => {
    // Confirming a first connection would charge every new vault a dialog for
    // a replacement that cannot be happening.
    const view = await renderVault(NOT_CONNECTED);

    const raised = await pressConnectThroughAlert(
      view,
      { address: VAULT_URL, key: TYPED_KEY },
      'none',
    );

    expect(raised).toHaveLength(0);
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  test('does not ask about replacing when there is nothing to send', async () => {
    const view = await renderVault(CONNECTED);

    const raised = await pressConnectThroughAlert(view, { address: '', key: TYPED_KEY }, 'none');

    expect(raised).toHaveLength(0);
    expect(within(view.getByTestId('vault-error')).getByText(VAULT_ADDRESS_MISSING)).toBeTruthy();
    expect(mockConnect).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

describe('VaultSettingsScreen — connecting', () => {
  test('sends exactly what was typed and reports the connection it made', async () => {
    const view = await renderVault(NOT_CONNECTED);

    await submitConnection(view, VAULT_URL, TYPED_KEY);

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockConnect).toHaveBeenCalledWith({ vault_url: VAULT_URL, api_key: TYPED_KEY });
    expect(within(view.getByTestId('vault-status')).getByText(VAULT_STATUS_CONNECTED)).toBeTruthy();
    expect(within(view.getByTestId('vault-connected-card')).getByText(VAULT_URL)).toBeTruthy();
  });

  test('asks for the address rather than sending an empty one', async () => {
    const view = await renderVault(NOT_CONNECTED);

    await submitConnection(view, '', TYPED_KEY);

    expect(within(view.getByTestId('vault-error')).getByText(VAULT_ADDRESS_MISSING)).toBeTruthy();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  test('asks for the key rather than sending an address alone', async () => {
    const view = await renderVault(NOT_CONNECTED);

    await submitConnection(view, VAULT_URL, '');

    expect(within(view.getByTestId('vault-error')).getByText(VAULT_KEY_MISSING)).toBeTruthy();
    expect(mockConnect).not.toHaveBeenCalled();
  });
});

describe('VaultSettingsScreen — what the server refused', () => {
  for (const [code, sentence] of REFUSALS) {
    test(`answers "${code}" with the sentence written for it`, async () => {
      mockConnect.mockRejectedValue(new ApiError(HTTP_UNPROCESSABLE, code));
      const view = await renderVault(NOT_CONNECTED);

      await submitConnection(view, 'not-a-vault', TYPED_KEY);

      expect(within(view.getByTestId('vault-error')).getByText(sentence)).toBeTruthy();
    });
  }

  test('falls back to the generic failure for a 422 code it does not know', async () => {
    mockConnect.mockRejectedValue(new ApiError(HTTP_UNPROCESSABLE, 'vault_url_from_the_future'));
    const view = await renderVault(NOT_CONNECTED);

    await submitConnection(view, VAULT_URL, TYPED_KEY);

    expect(within(view.getByTestId('vault-error')).getByText(VAULT_CONNECT_FAILED)).toBeTruthy();
  });

  test('falls back to the generic failure for a fault that is not a refusal', async () => {
    mockConnect.mockRejectedValue(new ApiError(HTTP_SERVER_ERROR, 'internal_error'));
    const view = await renderVault(NOT_CONNECTED);

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
    const spy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);

    fireEvent.press(view.getByTestId('disconnect-vault-button'));

    expect(spy).toHaveBeenCalledWith(
      VAULT_DISCONNECT_CONFIRM_TITLE,
      VAULT_DISCONNECT_CONFIRM_BODY,
      expect.anything(),
    );
    expect(mockDisconnect).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('disconnects once on the destructive answer and says the writing stays', async () => {
    const view = await renderVault(CONNECTED);
    mockConnection.mockResolvedValue(NOT_CONNECTED);

    await pressDisconnect(view, 'confirm');

    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(
      within(view.getByTestId('vault-status')).getByText(VAULT_STATUS_DISCONNECTED),
    ).toBeTruthy();
    expect(view.getByText(VAULT_NONE_CONNECTED)).toBeTruthy();
    expect(view.queryByTestId('disconnect-vault-button')).toBeNull();
  });

  test('does nothing at all on cancel', async () => {
    const view = await renderVault(CONNECTED);

    await pressDisconnect(view, 'cancel');

    expect(mockDisconnect).not.toHaveBeenCalled();
    expect(view.getByTestId('disconnect-vault-button')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// The credential
// ---------------------------------------------------------------------------

describe('VaultSettingsScreen — the key is write-only', () => {
  test('masks the key until somebody asks to see it', async () => {
    const view = await renderVault(NOT_CONNECTED);

    expect(view.getByTestId('vault-key-input').props.secureTextEntry).toBe(true);

    fireEvent.press(view.getByText(VAULT_KEY_SHOW));

    expect(view.getByTestId('vault-key-input').props.secureTextEntry).toBe(false);
  });

  test('renders the key nowhere, even in the sentence explaining a refusal', async () => {
    mockConnect.mockRejectedValue(new ApiError(HTTP_UNPROCESSABLE, 'vault_url_insecure_transport'));
    const view = await renderVault(NOT_CONNECTED);

    await submitConnection(view, 'http://vault.example', TYPED_KEY);

    expect(within(view.getByTestId('vault-error')).getByText(VAULT_ADDRESS_INSECURE)).toBeTruthy();
    expect(view.queryAllByText(new RegExp(TYPED_KEY, 'u'))).toHaveLength(0);
  });

  test('clears the field once the key has been sent', async () => {
    const view = await renderVault(NOT_CONNECTED);

    await submitConnection(view, VAULT_URL, TYPED_KEY);

    expect(view.getByTestId('vault-key-input').props.value).toBe('');
  });

  test('re-masks the key when a connect is sent', async () => {
    const view = await renderVault(NOT_CONNECTED);
    fireEvent.press(view.getByText(VAULT_KEY_SHOW));

    await submitConnection(view, VAULT_URL, TYPED_KEY);

    expect(view.getByTestId('vault-key-input').props.secureTextEntry).toBe(true);
    expect(view.getByTestId('vault-key-input').props.value).toBe('');
  });

  test('re-masks the key when the server refuses, and keeps it to correct the address', async () => {
    // The address is the part that was wrong, so the key stays put rather than
    // making somebody fetch it again -- but it goes back behind the mask.
    mockConnect.mockRejectedValue(new ApiError(HTTP_UNPROCESSABLE, 'vault_url_malformed'));
    const view = await renderVault(NOT_CONNECTED);
    fireEvent.press(view.getByText(VAULT_KEY_SHOW));

    await submitConnection(view, 'not-a-vault', TYPED_KEY);

    expect(view.getByTestId('vault-key-input').props.secureTextEntry).toBe(true);
    expect(view.getByTestId('vault-key-input').props.value).toBe(TYPED_KEY);
  });

  test('keeps the reveal when nothing was sent', async () => {
    // A press blocked by a blank field never reached the wire, so the reset
    // belongs to the send rather than to the button.
    const view = await renderVault(NOT_CONNECTED);
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

    await pressConnectThroughAlert(
      view,
      { address: REPLACEMENT_VAULT_URL, key: TYPED_KEY },
      'cancel',
    );

    expect(view.getByTestId('vault-key-input').props.secureTextEntry).toBe(false);
    expect(view.getByTestId('vault-key-input').props.value).toBe(TYPED_KEY);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  test('shows the address on the connected card and nothing key-shaped', async () => {
    const view = await renderVault(NOT_CONNECTED);

    await submitConnection(view, VAULT_URL, TYPED_KEY);

    const card = within(view.getByTestId('vault-connected-card'));
    expect(card.getByText(VAULT_URL)).toBeTruthy();
    expect(card.queryAllByText(new RegExp(TYPED_KEY, 'u'))).toHaveLength(0);
  });
});
