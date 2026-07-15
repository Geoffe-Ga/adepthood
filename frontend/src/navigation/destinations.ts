/**
 * The ordered registry of primary navigation destinations. The in-app navigation
 * drawer consumes it today; the tab bar is migrated onto it in a later step so
 * both surfaces draw from one source of truth. It fixes the order — Journal first,
 * the three optional depth rings in the middle, Map last — so a route added or
 * reordered here moves every consuming surface in lockstep.
 */
import {
  BookOpen,
  Compass,
  Flower2,
  NotebookPen,
  Sprout,
  type LucideIcon,
} from 'lucide-react-native';

import type { RootTabParamList } from './BottomTabs';

/** The depth-ring flag that gates an optional destination's visibility. */
export type NavDestinationRing = 'habits' | 'practices' | 'course';

/** One primary navigation destination: its route, label, icon, and optional ring. */
export interface NavDestination {
  /** Tab route name this destination navigates to. */
  name: keyof RootTabParamList;
  /** Human-readable row/tab label. */
  label: string;
  /** Live lucide icon component for the destination. */
  icon: LucideIcon;
  /** Depth ring that must be enabled for this destination; always shown when absent. */
  ring?: NavDestinationRing;
}

/**
 * Every primary destination in the fixed nav order. Journal leads and Map trails
 * (neither ring-gated); Habits, Practice, and Course sit between them, each tied
 * to the depth ring that governs whether it is shown.
 */
export const NAV_DESTINATIONS: ReadonlyArray<NavDestination> = [
  { name: 'Journal', label: 'Journal', icon: NotebookPen },
  { name: 'Habits', label: 'Habits', icon: Sprout, ring: 'habits' },
  { name: 'Practice', label: 'Practice', icon: Flower2, ring: 'practices' },
  { name: 'Course', label: 'Course', icon: BookOpen, ring: 'course' },
  { name: 'Map', label: 'Map', icon: Compass },
];
