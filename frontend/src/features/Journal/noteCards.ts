/**
 * Shared card chrome for the Journal note surfaces. Two deliberately distinct
 * families live here and must NOT be merged:
 *
 *   - The *paper* margin card (``paperMarginCard``) — a flat slip pinned beside
 *     a passage, lifted only by ``paperShadow.card`` (MarginNote,
 *     CompletionSuggestionNote).
 *   - The *raised* reflection card (``reflectionCardStyles``) — a larger,
 *     rounded panel on ``surface.raised`` with a warm accent stripe
 *     (CareSupportNote, ContractionReflectionNote).
 *
 * They share a shadow token but differ in ground, radius, spacing, and stripe;
 * collapsing them into one primitive would erase that intended contrast.
 */
import { StyleSheet } from 'react-native';
import type { ViewStyle } from 'react-native';

import {
  BORDER_RADIUS,
  SPACING,
  accent,
  colors,
  editorialType,
  ink,
  paperShadow,
  surface,
  touchTarget,
} from '@/design/tokens';

/** The paper margin slip's left border width, in dp. */
const PAPER_STRIPE_WIDTH = 3;

/** The raised reflection card's warm left stripe width, in dp. */
const ACCENT_STRIPE_WIDTH = 4;

/**
 * The flat paper margin card, parameterised by its left-stripe colour. Callers
 * pass a per-kind accent (or a hairline default) for ``borderLeftColor``. It
 * sits a touch above the page, lifted only by ``paperShadow.card`` — the shadow
 * does the separation, so the slip can match the page ground and still read as
 * a lifted note pinned to the margin.
 */
export function paperMarginCard(borderLeftColor: string): ViewStyle {
  return {
    minHeight: touchTarget.minimum,
    padding: SPACING.md,
    borderRadius: BORDER_RADIUS.md,
    backgroundColor: colors.paper.background,
    borderLeftWidth: PAPER_STRIPE_WIDTH,
    borderLeftColor,
    ...paperShadow.card,
  };
}

/** The raised reflection card shared by CareSupportNote and ContractionReflectionNote. */
export const reflectionCardStyles = StyleSheet.create({
  root: {
    margin: SPACING.lg,
    padding: SPACING.lg,
    borderRadius: BORDER_RADIUS.lg,
    backgroundColor: surface.raised,
    borderLeftWidth: ACCENT_STRIPE_WIDTH,
    borderLeftColor: accent.primary,
    ...paperShadow.card,
  },
  header: {
    ...editorialType.title,
    color: ink.primary,
    marginBottom: SPACING.md,
  },
});
