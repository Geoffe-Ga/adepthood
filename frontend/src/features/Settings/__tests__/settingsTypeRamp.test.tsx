/* eslint-env jest */
/* global describe, test, expect, beforeEach, jest */
import { fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { StyleSheet } from 'react-native';

import { legalFontSizes } from '../../../../e2e/textCensus';
import { sharePreviewStyles } from '../../Practice/screens/SharePreviewScreen';
import ApiKeySettingsScreen, { apiKeySettingsStyles } from '../ApiKeySettingsScreen';
import DeleteAccountScreen, { deleteAccountStyles } from '../DeleteAccountScreen';
import { exportDataStyles } from '../ExportDataScreen';
import { privateVaultActivationStyles } from '../PrivateVaultActivationScreen';
import { settingsFormStyles, settingsFormType } from '../shared/settingsFormLayout';
import TimezoneSettingsScreen, { timezoneSettingsStyles } from '../TimezoneSettingsScreen';

import { users, type AccountDeletionReceipt } from '@/api';
import { useApiKey } from '@/context/ApiKeyContext';
import { useAuth } from '@/context/AuthContext';
import { ink, type as typeRamp } from '@/design/tokens';

/**
 * The Settings form family and the shared-practice preview set their text on
 * the Candle & Ink type ramp (#2962).
 *
 * A face that must grow with the window -- a form title, a card label -- comes
 * from ``type(width)`` through ``settingsFormType``; a StyleSheet literal cannot
 * know the width, so it must sit on a step legal at both the phone and the
 * desktop profile the text census measures (as the Map does, #2960).
 */

/** Viewport the mocked dimensions hook reports; changed per test. */
let mockViewportWidth = 390;
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ width: mockViewportWidth, height: 844, scale: 1, fontScale: 1 }),
}));

jest.mock('@/config', () => ({ API_BASE_URL: 'http://test' }));
jest.mock('@/context/ApiKeyContext', () => ({ useApiKey: jest.fn() }));
jest.mock('@/context/AuthContext', () => ({ useAuth: jest.fn() }));
jest.mock('@/api', () => {
  const actual = jest.requireActual('@/api');
  return { ...actual, users: { deleteMyAccount: jest.fn(), updateMyTimezone: jest.fn() } };
});

const PHONE_WIDTH = 390;
const DESKTOP_WIDTH = 1280;
const WIDTHS = [PHONE_WIDTH, DESKTOP_WIDTH] as const;
/** DESIGN.md "One face per role": no region shows more than three sizes. */
const MAX_SIZES_PER_REGION = 3;
const STORED_KEY = 'sk-user-owned-example-key-0123456789';

const desktopLegal = legalFontSizes(DESKTOP_WIDTH);
const STATIC_LEGAL = new Set([...legalFontSizes(PHONE_WIDTH)].filter((s) => desktopLegal.has(s)));

const mockUseApiKey = useApiKey as jest.MockedFunction<typeof useApiKey>;
const mockUseAuth = useAuth as jest.MockedFunction<typeof useAuth>;
const mockDeleteMyAccount = users.deleteMyAccount as jest.MockedFunction<
  typeof users.deleteMyAccount
>;

const RECEIPT: AccountDeletionReceipt = {
  recoverable: false,
  rows_erased: 42,
  erased: ['habit'],
  anonymised: [],
  retained: [],
  vault: { configured: false, purged: false, guidance: 'No vault was connected.' },
};

function setApiKey(apiKey: string | null): void {
  mockUseApiKey.mockReturnValue({
    apiKey,
    isLoading: false,
    loadError: null,
    saveApiKey: jest.fn(() => Promise.resolve({ persisted: true })),
    clearApiKey: jest.fn(() => Promise.resolve({ cleared: true })),
  } as unknown as ReturnType<typeof useApiKey>);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockViewportWidth = PHONE_WIDTH;
  mockUseAuth.mockReturnValue({
    userTimezone: 'Europe/Paris',
    setUserTimezone: jest.fn(),
    logout: jest.fn(() => Promise.resolve()),
  } as unknown as ReturnType<typeof useAuth>);
});

const flat = (node: { props: { style?: unknown } }) =>
  StyleSheet.flatten(node.props.style as object) as {
    fontSize?: number;
    color?: string;
  };

describe('the Settings form title is on type(width).title (#2962)', () => {
  test.each(WIDTHS)(
    'the BotMason API Key title sits on type(%i).title and is a header',
    (width) => {
      mockViewportWidth = width;
      setApiKey(null);
      const { getByText } = render(<ApiKeySettingsScreen />);
      const title = getByText('BotMason API Key');
      expect(flat(title).fontSize).toBe(typeRamp(width).title.fontSize);
      expect(flat(title).color).toBe(ink.primary);
      expect(title.props.accessibilityRole).toBe('header');
    },
  );

  test.each(WIDTHS)(
    'the post-delete title sits on type(%i).title and is a header',
    async (width) => {
      mockViewportWidth = width;
      mockDeleteMyAccount.mockResolvedValue(RECEIPT);
      const { getByTestId, findByText } = render(<DeleteAccountScreen />);
      fireEvent.changeText(getByTestId('delete-account-email-input'), 'writer@example.com');
      fireEvent.press(getByTestId('delete-account-submit'));
      const title = await findByText('Your account is gone');
      expect(flat(title).fontSize).toBe(typeRamp(width).title.fontSize);
      expect(title.props.accessibilityRole).toBe('header');
    },
  );

  test('settingsFormType takes the title and caption faces from the ramp, legal at each width', () => {
    expect(settingsFormType(PHONE_WIDTH).title.fontSize).toBe(26);
    expect(settingsFormType(DESKTOP_WIDTH).title.fontSize).toBe(30);
    expect(settingsFormType(PHONE_WIDTH).cardLabel.fontSize).toBe(13);
    expect(settingsFormType(DESKTOP_WIDTH).cardLabel.fontSize).toBe(15);
    for (const width of WIDTHS) {
      const face = settingsFormType(width);
      expect(legalFontSizes(width).has(face.title.fontSize)).toBe(true);
      expect(legalFontSizes(width).has(face.cardLabel.fontSize)).toBe(true);
    }
  });
});

describe('the small uppercase card labels are the ramp caption (#2962)', () => {
  test.each(WIDTHS)('"Current time zone" is type(%i).caption and not pressable', (width) => {
    mockViewportWidth = width;
    const { getByText } = render(<TimezoneSettingsScreen />);
    const label = getByText('Current time zone');
    expect(flat(label).fontSize).toBe(typeRamp(width).caption.fontSize);
    expect(flat(label).color).toBe(ink.muted);
    expect(label.props.onPress).toBeUndefined();
    expect(label.parent?.props.accessibilityRole).toBeUndefined();
  });

  test.each(WIDTHS)('"Stored on this device" is type(%i).caption and not pressable', (width) => {
    mockViewportWidth = width;
    setApiKey(STORED_KEY);
    const { getByText } = render(<ApiKeySettingsScreen />);
    const label = getByText('Stored on this device');
    expect(flat(label).fontSize).toBe(typeRamp(width).caption.fontSize);
    expect(flat(label).color).toBe(ink.muted);
    expect(label.props.onPress).toBeUndefined();
    expect(label.parent?.props.accessibilityRole).toBeUndefined();
  });
});

describe('the managed-vault custody notice title is a static ramp step (#2962)', () => {
  test('noticeTitle is 18, legal at 390 and at 1280', () => {
    expect(StyleSheet.flatten(privateVaultActivationStyles.noticeTitle).fontSize).toBe(18);
  });
});

/** Every sheet the family paints with, namespaced so no key can mask another. */
const SHEETS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  form: settingsFormStyles,
  apiKey: apiKeySettingsStyles,
  timezone: timezoneSettingsStyles,
  export: exportDataStyles,
  delete: deleteAccountStyles,
  vault: privateVaultActivationStyles,
  share: sharePreviewStyles,
};

const sheets: Readonly<Record<string, unknown>> = Object.fromEntries(
  Object.entries(SHEETS).flatMap(([prefix, sheet]) =>
    Object.entries(sheet).map(([key, style]) => [`${prefix}.${key}`, style]),
  ),
);

const sizeOf = (key: string): number | undefined =>
  (StyleSheet.flatten(sheets[key] as object) as { fontSize?: number } | undefined)?.fontSize;

const sized = Object.keys(sheets).filter((key) => typeof sizeOf(key) === 'number');

type RampFace = 'title' | 'caption';

interface Region {
  keys: readonly string[];
  ramp?: readonly RampFace[];
}

/** Each region a reader sees at once, with the static keys and ramp faces it paints. */
const REGIONS: Readonly<Record<string, Region>> = {
  'API key intro': { keys: ['form.body', 'apiKey.hint'], ramp: ['title'] },
  'API key model choice': { keys: [], ramp: ['caption'] },
  'API key stored card': { keys: ['apiKey.storedValue'], ramp: ['caption'] },
  'API key providers': {
    keys: ['form.inputLabel', 'apiKey.providerName', 'apiKey.providerHint'],
  },
  'API key form': {
    keys: [
      'form.inputLabel',
      'apiKey.input',
      'apiKey.revealButtonText',
      'apiKey.detected',
      'form.primaryButtonText',
    ],
  },
  'Time zone intro': { keys: ['form.body'] },
  'Time zone card': { keys: ['timezone.currentValue'], ramp: ['caption'] },
  'Time zone form': {
    keys: [
      'form.inputLabel',
      'timezone.input',
      'timezone.secondaryButtonText',
      'form.primaryButtonText',
    ],
  },
  'Export options': { keys: ['form.body', 'export.optionButtonText', 'export.optionDescription'] },
  'Export receipt and caveats': {
    keys: [
      'export.receipt',
      'export.receiptFollowUp',
      'export.caution',
      'export.listItem',
      'form.inputLabel',
    ],
  },
  'Delete warning and form': {
    keys: [
      'delete.warning',
      'form.inputLabel',
      'delete.listItem',
      'delete.input',
      'delete.destructiveButtonText',
    ],
  },
  'Delete receipt': {
    keys: ['form.body', 'delete.vaultGuidance', 'form.primaryButtonText'],
    ramp: ['title'],
  },
  'Vault custody notice': { keys: ['vault.noticeTitle', 'vault.body'] },
  'Vault activation content': {
    keys: ['vault.sectionTitle', 'vault.body', 'vault.floor', 'vault.error'],
  },
  'Share preview header': { keys: ['share.subHeading', 'share.duration'], ramp: ['title'] },
  'Share preview body': {
    keys: ['share.bodyLabel', 'share.bodyText', 'share.cancelButtonText', 'share.importButtonText'],
  },
  'Share preview result': {
    keys: ['share.successHeading', 'share.successText', 'share.errorText'],
  },
};

const filed = new Set(Object.values(REGIONS).flatMap((region) => region.keys));

describe('every size the family sets is on the ramp (#2962)', () => {
  test('derives the static-legal sizes as the 390 and 1280 ramps intersected', () => {
    expect([...STATIC_LEGAL].sort((a, b) => a - b)).toEqual([13, 14, 15, 16, 18, 20, 26, 34]);
  });

  test('sets every static size on a step legal at both 390 and 1280', () => {
    const offRamp = sized
      .filter((key) => !STATIC_LEGAL.has(sizeOf(key) as number))
      .map((key) => `${key}=${sizeOf(key)}`);
    expect(offRamp).toEqual([]);
  });

  test('leaves the form title and card label sizeless, so only the ramp face sizes them', () => {
    expect(sizeOf('form.title')).toBeUndefined();
    expect(sizeOf('form.cardLabel')).toBeUndefined();
    expect(sizeOf('share.heading')).toBeUndefined();
  });

  test('files every sized style under a region, so none escapes the face count', () => {
    expect(sized.filter((key) => !filed.has(key))).toEqual([]);
    expect([...filed].filter((key) => !sized.includes(key))).toEqual([]);
  });

  test.each(WIDTHS)('shows at most three sizes in any region at %i', (width) => {
    const face = typeRamp(width);
    const crowded = Object.entries(REGIONS)
      .map(([name, region]) => {
        const sizes = new Set([
          ...region.keys.map((key) => sizeOf(key) as number),
          ...(region.ramp ?? []).map((role) => face[role].fontSize),
        ]);
        return { name, sizes: [...sizes].sort((a, b) => a - b) };
      })
      .filter(({ sizes }) => sizes.length > MAX_SIZES_PER_REGION)
      .map(({ name, sizes }) => `${name}: ${sizes.join(',')}`);
    expect(crowded).toEqual([]);
  });
});
