/* eslint-env jest */
/* global describe, it, expect, beforeEach, jest */
import NetInfo from '@react-native-community/netinfo';
import { render, act, waitFor } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

import { OfflineBanner } from '../../components/OfflineBanner';
import { NetworkStatusProvider, useNetworkStatus } from '../NetworkStatusContext';

type NetInfoState = { isConnected: boolean; isInternetReachable: boolean | null };

/**
 * BUG-FRONTEND-INFRA-005 — ensure the banner only appears when both the
 * device-level "connected" flag and the reachability probe agree.
 */

const mockedNetInfo = NetInfo as unknown as {
  fetch: jest.Mock;
  addEventListener: jest.Mock;
};

function StatusText(): React.JSX.Element {
  const { isOnline } = useNetworkStatus();
  return <Text testID="network-text">{isOnline ? 'online' : 'offline'}</Text>;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedNetInfo.fetch.mockResolvedValue({
    isConnected: true,
    isInternetReachable: true,
  } as NetInfoState);
  mockedNetInfo.addEventListener.mockImplementation(() => () => undefined);
});

describe('NetworkStatusContext', () => {
  it('reports online on a healthy NetInfo snapshot', async () => {
    const { getByTestId } = render(
      <NetworkStatusProvider>
        <StatusText />
      </NetworkStatusProvider>,
    );
    await waitFor(() => expect(getByTestId('network-text').props.children).toBe('online'));
  });

  it('flips to offline when the listener fires a disconnected state', async () => {
    let listener: ((state: NetInfoState) => void) | null = null;
    mockedNetInfo.addEventListener.mockImplementation((fn: (s: NetInfoState) => void) => {
      listener = fn;
      return () => undefined;
    });
    const { getByTestId } = render(
      <NetworkStatusProvider>
        <StatusText />
      </NetworkStatusProvider>,
    );
    await waitFor(() => expect(getByTestId('network-text').props.children).toBe('online'));
    await act(async () => {
      listener?.({ isConnected: false, isInternetReachable: false });
    });
    expect(getByTestId('network-text').props.children).toBe('offline');
  });

  it('does not render the OfflineBanner when online', () => {
    const { queryByTestId } = render(
      <NetworkStatusProvider>
        <OfflineBanner />
      </NetworkStatusProvider>,
    );
    expect(queryByTestId('offline-banner')).toBeNull();
  });

  it('renders the OfflineBanner once the provider reports offline', async () => {
    let listener: ((state: NetInfoState) => void) | null = null;
    mockedNetInfo.addEventListener.mockImplementation((fn: (s: NetInfoState) => void) => {
      listener = fn;
      return () => undefined;
    });
    // Seed fetch with an offline result so the initial probe doesn't
    // immediately overwrite the listener-driven state.
    mockedNetInfo.fetch.mockResolvedValue({
      isConnected: false,
      isInternetReachable: false,
    });
    const { findByTestId } = render(
      <NetworkStatusProvider>
        <OfflineBanner />
      </NetworkStatusProvider>,
    );
    await act(async () => {
      listener?.({ isConnected: false, isInternetReachable: null });
    });
    expect(await findByTestId('offline-banner')).toBeTruthy();
  });
});
