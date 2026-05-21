import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { decompose, totalSteps } from '../engine/tallied';
import type { TalliedPosition } from '../engine/tallied';
import type { RitualControls, RitualState, TalliedGroundingConfig } from '../engine/types';

import RitualControlsBar from './RitualControlsBar';

import { BORDER_RADIUS, SPACING, colors, shadows } from '@/design/tokens';

/**
 * `TalliedGroundingView` drives the Find Shapes / Find Colors ritual UX.
 *
 * The engine keeps a single linear `currentStepIndex`; this view derives
 * the `(round, category, item)` position via `decompose` and never mutates
 * the engine's state shape. Each `controls.tap()` advances one item; the
 * final tap moves the engine to `complete` and the Complete card replaces
 * the active prompt.
 */
interface Props {
  config: TalliedGroundingConfig;
  state: RitualState;
  controls: RitualControls;
  /** Optional Save callback; the parent typically launches the insight modal. */
  onSave?: () => void;
}

const TalliedGroundingView = ({ config, state, controls, onSave }: Props): React.JSX.Element => {
  const total = totalSteps(config);
  const isComplete = state.status === 'complete' || state.currentStepIndex >= total;
  const position = decompose(state.currentStepIndex, config);
  const canAdvance = state.status === 'running' && !isComplete;
  return (
    <View style={styles.container} testID="tallied-grounding-view">
      <TalliedHeader config={config} position={isComplete ? null : position} />
      {isComplete ? (
        <CompleteCard onSave={onSave} />
      ) : (
        <ActivePrompt position={position} canAdvance={canAdvance} onTap={controls.tap} />
      )}
      <RitualControlsBar status={state.status} controls={controls} startLabel="Begin grounding" />
    </View>
  );
};

interface HeaderProps {
  config: TalliedGroundingConfig;
  position: TalliedPosition | null;
}

const TalliedHeader = ({ config, position }: HeaderProps): React.JSX.Element => (
  <View
    style={styles.header}
    testID="tallied-grounding-header"
    accessibilityRole="header"
    accessibilityLabel="Tallied grounding"
  >
    <Text style={styles.badge} testID="tallied-grounding-badge">
      {`${config.categories.length} × ${config.rounds}`}
    </Text>
    {position && (
      <Text style={styles.round} testID="tallied-grounding-round">
        {`Round ${position.roundIndex + 1} of ${config.rounds}`}
      </Text>
    )}
  </View>
);

const CompleteCard = ({ onSave }: { onSave?: () => void }): React.JSX.Element => (
  <View style={styles.completeCard} testID="tallied-grounding-complete">
    <Text style={styles.completeTitle}>Grounding complete</Text>
    <Text style={styles.completeBody}>You tallied every round. Save the session below.</Text>
    <Pressable
      style={[styles.save, !onSave && styles.saveDisabled]}
      onPress={onSave}
      disabled={!onSave}
      testID="tallied-grounding-save"
      accessibilityRole="button"
      accessibilityLabel="Save session and reflect"
      accessibilityState={{ disabled: !onSave }}
    >
      <Text style={styles.saveText}>Save session</Text>
    </Pressable>
  </View>
);

interface ActivePromptProps {
  position: TalliedPosition;
  canAdvance: boolean;
  onTap: () => void;
}

const ActivePrompt = ({ position, canAdvance, onTap }: ActivePromptProps): React.JSX.Element => {
  const { category, itemInCategory } = position;
  const promptText = `Find ${category.label} (${itemInCategory + 1} of ${category.target_count})`;
  return (
    <>
      <Text style={styles.prompt} testID="tallied-grounding-prompt">
        {promptText}
      </Text>
      <Pressable
        style={[styles.advance, !canAdvance && styles.advanceDisabled]}
        onPress={canAdvance ? onTap : undefined}
        disabled={!canAdvance}
        testID="tallied-grounding-advance"
        accessibilityRole="button"
        accessibilityLabel={`Tally ${category.label}`}
        accessibilityState={{ disabled: !canAdvance }}
      >
        <Text style={styles.advanceText}>I found one</Text>
      </Pressable>
    </>
  );
};

const styles = StyleSheet.create({
  container: { alignItems: 'center', padding: SPACING.xl },
  header: { alignItems: 'center', marginBottom: SPACING.xl },
  badge: {
    fontSize: 36,
    fontWeight: '700',
    letterSpacing: 4,
    color: colors.text.primary,
    marginBottom: SPACING.sm,
  },
  round: {
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: 2,
    color: colors.text.primary,
  },
  prompt: {
    fontSize: 20,
    fontWeight: '500',
    color: colors.text.primary,
    textAlign: 'center',
    marginBottom: SPACING.xxl,
    paddingHorizontal: SPACING.lg,
  },
  advance: {
    backgroundColor: colors.primary,
    paddingVertical: SPACING.buttonV,
    paddingHorizontal: SPACING.xxl,
    borderRadius: BORDER_RADIUS.lg,
    marginBottom: SPACING.xl,
    minWidth: 220,
    alignItems: 'center',
    ...shadows.small,
  },
  advanceDisabled: { opacity: 0.5 },
  advanceText: {
    color: colors.text.light,
    fontSize: 18,
    fontWeight: '600',
  },
  completeCard: {
    backgroundColor: colors.background.card,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.xl,
    alignItems: 'center',
    marginBottom: SPACING.xl,
    maxWidth: 320,
    ...shadows.small,
  },
  completeTitle: {
    fontSize: 22,
    fontWeight: '600',
    color: colors.success,
    marginBottom: SPACING.sm,
  },
  completeBody: {
    fontSize: 14,
    color: colors.text.secondaryAccessible,
    textAlign: 'center',
    marginBottom: SPACING.lg,
  },
  save: {
    backgroundColor: colors.success,
    paddingVertical: SPACING.buttonV,
    paddingHorizontal: SPACING.xxl,
    borderRadius: BORDER_RADIUS.lg,
    minWidth: 220,
    alignItems: 'center',
    ...shadows.small,
  },
  saveDisabled: { opacity: 0.5 },
  saveText: { color: colors.text.light, fontSize: 18, fontWeight: '600' },
});

export default TalliedGroundingView;
