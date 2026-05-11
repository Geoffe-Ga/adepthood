// Haptic feedback adapter. Maps engine cue kinds to expo-haptics primitives.
// metronome_tick is intentionally silent — haptics on every beat is awful.

import * as Haptics from 'expo-haptics';

import type { CueKind, HapticsAdapter } from '../types';

/** No-op adapter for tests and platforms without haptic hardware. */
export function createNoopHapticsAdapter(): HapticsAdapter {
  return { cue: () => undefined };
}

export function createExpoHapticsAdapter(): HapticsAdapter {
  return {
    cue: (kind) => {
      void fireHaptic(kind);
    },
  };
}

async function fireHaptic(kind: CueKind): Promise<void> {
  try {
    switch (kind) {
      case 'start_bell':
      case 'halfway_bell':
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        return;
      case 'interval_bell':
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        return;
      case 'end_bell':
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        return;
      case 'metronome_tick':
        return;
      default:
        // Exhaustiveness guard: if a new CueKind is added to the union, the
        // assignment below fails to compile, forcing this switch to be updated.
        ((_x: never): void => undefined)(kind);
        return;
    }
  } catch {
    // Haptic hardware may be unavailable (web, simulator). Swallow silently;
    // the practice continues without tactile feedback.
  }
}
