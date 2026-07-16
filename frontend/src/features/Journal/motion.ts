/**
 * Motion for the Journal surfaces. This module now only re-exports the shared
 * press-scale hook so cards can press down when tapped; entrance/settle motion
 * lives in the app-wide ``useEntrance`` hook.
 */
export { usePressScale, PRESS_SCALE } from '@/hooks/usePressScale';
