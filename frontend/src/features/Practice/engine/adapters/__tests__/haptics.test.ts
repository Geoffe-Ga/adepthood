import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as Haptics from 'expo-haptics';

import { createExpoHapticsAdapter } from '../haptics';

const impactMock = Haptics.impactAsync as jest.MockedFunction<typeof Haptics.impactAsync>;
const notificationMock = Haptics.notificationAsync as jest.MockedFunction<
  typeof Haptics.notificationAsync
>;

describe('createExpoHapticsAdapter', () => {
  beforeEach(() => {
    impactMock.mockClear();
    notificationMock.mockClear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fires Light impact for start_bell and halfway_bell', async () => {
    const adapter = createExpoHapticsAdapter();
    adapter.cue('start_bell');
    adapter.cue('halfway_bell');
    await new Promise((resolve) => setImmediate(resolve));
    expect(impactMock).toHaveBeenCalledTimes(2);
    expect(impactMock).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Light);
  });

  it('fires Medium impact for interval_bell', async () => {
    const adapter = createExpoHapticsAdapter();
    adapter.cue('interval_bell');
    await new Promise((resolve) => setImmediate(resolve));
    expect(impactMock).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Medium);
  });

  it('fires Success notification for end_bell', async () => {
    const adapter = createExpoHapticsAdapter();
    adapter.cue('end_bell');
    await new Promise((resolve) => setImmediate(resolve));
    expect(notificationMock).toHaveBeenCalledWith(Haptics.NotificationFeedbackType.Success);
  });

  it('skips haptics for metronome_tick (would be a constant buzz)', async () => {
    const adapter = createExpoHapticsAdapter();
    adapter.cue('metronome_tick');
    await new Promise((resolve) => setImmediate(resolve));
    expect(impactMock).not.toHaveBeenCalled();
    expect(notificationMock).not.toHaveBeenCalled();
  });

  it('swallows hardware errors silently', async () => {
    impactMock.mockRejectedValueOnce(new Error('no taptic'));
    const adapter = createExpoHapticsAdapter();
    expect(() => adapter.cue('start_bell')).not.toThrow();
    // Allow the swallowed rejection to settle.
    await new Promise((resolve) => setImmediate(resolve));
  });
});
