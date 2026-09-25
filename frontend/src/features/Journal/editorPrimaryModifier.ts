/**
 * Which modifier the platform's formatting shortcuts use.
 *
 * Command on Apple platforms and Control elsewhere -- never both, because
 * macOS binds Ctrl+B / Ctrl+I to caret movement in every text field.
 */
import { Platform } from 'react-native';

import type { PrimaryModifier } from './markdownCommands';

const APPLE_PLATFORM = /Mac|iPhone|iPad|iPod/u;

interface NavigatorLike {
  platform?: string;
  userAgent?: string;
}

export function editorPrimaryModifier(): PrimaryModifier {
  if (Platform.OS === 'ios' || Platform.OS === 'macos') return 'meta';
  if (Platform.OS !== 'web') return 'ctrl';
  const nav = (globalThis as { navigator?: NavigatorLike }).navigator;
  return APPLE_PLATFORM.test(`${nav?.platform ?? ''} ${nav?.userAgent ?? ''}`) ? 'meta' : 'ctrl';
}
