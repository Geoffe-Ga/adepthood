/**
 * Drive device connectivity from a ``JournalEntryScreen`` spec (#2930).
 *
 * The NetInfo jest mock (``src/__mocks__/netinfo.js``) is statically online and
 * drops its listener, so a spec that renders the screen inside
 * ``NetworkStatusProvider`` calls {@link captureNetInfoListener} before
 * rendering, then {@link NetInfoHandle.emit} to flip the device offline or back
 * online — exactly as a real NetInfo change event would.
 *
 * ``NetworkStatusProvider`` also registers ``setNetworkOnlineGetter`` from
 * ``@/api``, so a spec's ``jest.mock('@/api')`` factory must provide it (a
 * ``jest.fn()`` is enough) or the provider's effect throws on mount.
 */
import type { jest } from '@jest/globals';
import NetInfo from '@react-native-community/netinfo';
import { act } from '@testing-library/react-native';

interface ConnectivitySnapshot {
  isConnected: boolean;
  isInternetReachable: boolean;
}

type ConnectivityListener = (_state: ConnectivitySnapshot) => void;

export interface NetInfoHandle {
  /** Deliver a connectivity change to the provider, inside ``act``. */
  emit: (_online: boolean) => Promise<void>;
}

const mockedNetInfo = NetInfo as unknown as {
  addEventListener: jest.Mock<(_listener: ConnectivityListener) => () => void>;
};

/** Capture the provider's NetInfo subscription so a spec can emit changes to it. */
export function captureNetInfoListener(): NetInfoHandle {
  let listener: ConnectivityListener | null = null;
  mockedNetInfo.addEventListener.mockImplementation((next) => {
    listener = next;
    return () => undefined;
  });
  return {
    emit: async (online) => {
      await act(async () => {
        listener?.({ isConnected: online, isInternetReachable: online });
      });
    },
  };
}
