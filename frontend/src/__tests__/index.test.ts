/* eslint-env jest */
/* global describe, it, expect, jest */

/**
 * The entry point is where error monitoring is switched on. A seam nobody
 * called would report nothing, and no test of the seam itself would notice —
 * so this executes the real entry module and watches the order of the calls.
 */

jest.mock('react-native-reanimated', () => ({}));
jest.mock('expo', () => ({ registerRootComponent: jest.fn() }));
jest.mock('../App', () => ({ __esModule: true, default: () => null }));
jest.mock('../observability/sentry', () => ({ initErrorMonitoring: jest.fn() }));
jest.mock('../utils/webViewport', () => ({ applyWebViewportLock: jest.fn() }));
jest.mock('../utils/webSelection', () => ({ applyWebSelectionTheme: jest.fn() }));

describe('app entry point', () => {
  it('initialises error monitoring before the root component is registered', () => {
    require('../index');

    const { initErrorMonitoring } = jest.requireMock('../observability/sentry') as {
      initErrorMonitoring: jest.Mock;
    };
    const { registerRootComponent } = jest.requireMock('expo') as {
      registerRootComponent: jest.Mock;
    };

    expect(initErrorMonitoring).toHaveBeenCalledTimes(1);
    expect(registerRootComponent).toHaveBeenCalledTimes(1);
    const [initOrder = 0] = initErrorMonitoring.mock.invocationCallOrder;
    const [registerOrder = 0] = registerRootComponent.mock.invocationCallOrder;
    // A crash during the very first render must already have somewhere to go.
    expect(initOrder).toBeLessThan(registerOrder);
  });
});
