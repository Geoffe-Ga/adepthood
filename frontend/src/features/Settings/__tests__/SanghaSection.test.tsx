/* eslint-env jest */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { fireEvent, render, within } from '@testing-library/react-native';
import React from 'react';

/**
 * The Digital Sangha section: a door held open in Settings, and nothing else.
 *
 * Two failure modes are what these tests exist for. One is a dead door — an
 * unconfigured build shipping a row that opens nothing. The other is a door
 * that will not stay shut: the person turned the Sangha depth off and the app
 * kept offering anyway. Both are silent, and both are the exact opposite of
 * "you choose your depth".
 */

const CONFIGURED_URL = 'https://discord.gg/example-sangha';

let mockInviteUrl = CONFIGURED_URL;

jest.mock('@/config', () => ({
  get SANGHA_INVITE_URL(): string {
    return mockInviteUrl;
  },
}));

const mockOpenExternalUrl = jest.fn<(_url: string) => Promise<boolean>>(() =>
  Promise.resolve(true),
);

jest.mock('@/utils/openExternalUrl', () => ({
  openExternalUrl: (url: string) => mockOpenExternalUrl(url),
}));

interface MockState {
  enable_habits: boolean;
  enable_practices: boolean;
  enable_course: boolean;
  enable_sangha: boolean;
}

let mockStoreState: MockState = {
  enable_habits: true,
  enable_practices: true,
  enable_course: true,
  enable_sangha: true,
};

jest.mock('@/store/useDepthPreferencesStore', () => ({
  useDepthPreferencesStore: jest.fn((selector: (_s: MockState) => unknown) =>
    selector(mockStoreState),
  ),
  selectEnableSangha: (s: MockState): boolean => s.enable_sangha,
}));

import { SANGHA_DECLINE_HINT, SANGHA_LEAD, SANGHA_ROW_LABEL } from '../sanghaInvite';
import SanghaSection from '../SanghaSection';

const SECTION_TEST_ID = 'settings-group-sangha';
const ROW_TEST_ID = 'settings-row-sangha-discord';

beforeEach(() => {
  jest.clearAllMocks();
  mockInviteUrl = CONFIGURED_URL;
  mockStoreState = {
    enable_habits: true,
    enable_practices: true,
    enable_course: true,
    enable_sangha: true,
  };
});

describe('SanghaSection when the depth is open and an invite is configured', () => {
  it('offers the section and its single row', () => {
    const { getByTestId } = render(<SanghaSection />);

    const section = getByTestId(SECTION_TEST_ID);
    expect(within(section).getByTestId(ROW_TEST_ID)).toBeTruthy();
  });

  it('reads as an invitation, stating the app is whole without it', () => {
    const { getByText } = render(<SanghaSection />);

    expect(getByText(SANGHA_LEAD)).toBeTruthy();
  });

  it('points at the toggle that closes the door, so declining is one tap away', () => {
    const { getByText } = render(<SanghaSection />);

    expect(getByText(SANGHA_DECLINE_HINT)).toBeTruthy();
  });

  it('hands the configured URL to the platform browser when pressed', () => {
    const { getByTestId } = render(<SanghaSection />);

    fireEvent.press(getByTestId(ROW_TEST_ID));

    expect(mockOpenExternalUrl).toHaveBeenCalledTimes(1);
    expect(mockOpenExternalUrl).toHaveBeenCalledWith(CONFIGURED_URL);
  });

  it('follows a re-configured invite rather than a URL baked in at import', () => {
    // The permanent invite has to be replaceable without a store release, so
    // the component must read config at render, not once at module load.
    const replacement = 'https://discord.gg/second-sangha';
    mockInviteUrl = replacement;

    const { getByTestId } = render(<SanghaSection />);
    fireEvent.press(getByTestId(ROW_TEST_ID));

    expect(mockOpenExternalUrl).toHaveBeenCalledWith(replacement);
  });

  it('is a button that announces where it goes', () => {
    const { getByTestId } = render(<SanghaSection />);
    const row = getByTestId(ROW_TEST_ID);

    expect(row.props.accessibilityRole).toBe('button');
    expect(row.props.accessibilityLabel).toBe(SANGHA_ROW_LABEL);
  });

  it('shows no badge, count, or streak — nothing rendered is a number', () => {
    const { getByTestId } = render(<SanghaSection />);
    const section = getByTestId(SECTION_TEST_ID);

    for (const node of within(section).getAllByText(/\S/u)) {
      expect(String(node.props.children)).not.toMatch(/\d/u);
    }
  });
});

describe('SanghaSection once the depth is declined', () => {
  beforeEach(() => {
    mockStoreState = { ...mockStoreState, enable_sangha: false };
  });

  it('renders nothing at all', () => {
    const { toJSON } = render(<SanghaSection />);

    expect(toJSON()).toBeNull();
  });

  it('leaves no row behind to press', () => {
    const { queryByTestId } = render(<SanghaSection />);

    expect(queryByTestId(ROW_TEST_ID)).toBeNull();
  });

  it('stays gone across a remount, which is what a cold start is', () => {
    // The declined flag lives on the server row, so the section a returning
    // session renders is the one the choice left behind, not a fresh offer.
    render(<SanghaSection />).unmount();

    const { queryByTestId } = render(<SanghaSection />);

    expect(queryByTestId(SECTION_TEST_ID)).toBeNull();
  });

  it('comes back when the depth is opened again, so declining is reversible', () => {
    mockStoreState = { ...mockStoreState, enable_sangha: true };

    const { getByTestId } = render(<SanghaSection />);

    expect(getByTestId(ROW_TEST_ID)).toBeTruthy();
  });
});

describe('SanghaSection when no invite is configured', () => {
  it('offers nothing rather than a row that opens nothing', () => {
    mockInviteUrl = '';

    const { queryByTestId } = render(<SanghaSection />);

    expect(queryByTestId(SECTION_TEST_ID)).toBeNull();
  });

  it('offers nothing for a non-https invite', () => {
    mockInviteUrl = 'http://discord.gg/example-sangha';

    const { queryByTestId } = render(<SanghaSection />);

    expect(queryByTestId(SECTION_TEST_ID)).toBeNull();
  });
});
