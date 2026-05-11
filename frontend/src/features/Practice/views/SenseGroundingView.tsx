import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type {
  RitualControls,
  RitualState,
  SenseGroundingConfig,
  SenseKind,
  SensePrompt,
} from '../engine/types';

import RitualControlsBar from './RitualControlsBar';

import { BORDER_RADIUS, SPACING, colors, shadows } from '@/design/tokens';

/**
 * Canonical 5-4-3-2-1 grounding counts.
 *
 * The classic anxiety-regulation exercise asks for five sights, four
 * touches, three sounds, two smells, and one taste. The badge copy is
 * derived from this mapping rather than from `config.prompts.length` so
 * the header reads identically across slightly customised prompt sets.
 */
const SENSE_COUNT: Readonly<Record<SenseKind, number>> = {
  sight: 5,
  touch: 4,
  hearing: 3,
  smell: 2,
  taste: 1,
};

/** Verb shown in the header for each sense ("5 things you can SEE"). */
const SENSE_VERB: Readonly<Record<SenseKind, string>> = {
  sight: 'SEE',
  touch: 'TOUCH',
  hearing: 'HEAR',
  smell: 'SMELL',
  taste: 'TASTE',
};

interface Props {
  config: SenseGroundingConfig;
  state: RitualState;
  controls: RitualControls;
  /** Optional Save callback; the parent typically launches the insight modal. */
  onSave?: () => void;
}

const SenseGroundingView = ({ config, state, controls, onSave }: Props): React.JSX.Element => {
  const total = config.prompts.length;
  const currentIdx = Math.min(state.currentStepIndex, total - 1);
  const activePrompt = config.prompts[currentIdx];
  const isComplete = state.status === 'complete' || state.currentStepIndex >= total;
  const canAdvance = state.status === 'running' && !isComplete;
  return (
    <View style={styles.container} testID="sense-grounding-view">
      <SenseHeader prompt={isComplete ? null : activePrompt} />
      {isComplete ? (
        <CompleteCard onSave={onSave} />
      ) : (
        activePrompt && (
          <ActivePrompt prompt={activePrompt} canAdvance={canAdvance} onTap={controls.tap} />
        )
      )}
      <RitualControlsBar status={state.status} controls={controls} startLabel="Begin grounding" />
    </View>
  );
};

const SenseHeader = ({ prompt }: { prompt: SensePrompt | null | undefined }): React.JSX.Element => (
  <View
    style={styles.header}
    testID="sense-grounding-header"
    accessibilityRole="header"
    accessibilityLabel="5-4-3-2-1 grounding"
  >
    <Text style={styles.badge} testID="sense-grounding-badge">
      5-4-3-2-1
    </Text>
    {prompt && (
      <Text style={styles.count} testID="sense-grounding-count">
        {`${SENSE_COUNT[prompt.sense]} things you can `}
        <Text style={styles.countVerb}>{SENSE_VERB[prompt.sense]}</Text>
      </Text>
    )}
  </View>
);

const CompleteCard = ({ onSave }: { onSave?: () => void }): React.JSX.Element => (
  <View style={styles.completeCard} testID="sense-grounding-complete">
    <Text style={styles.completeTitle}>Grounding complete</Text>
    <Text style={styles.completeBody}>
      You moved through all five senses. Save the session below.
    </Text>
    <Pressable
      style={[styles.save, !onSave && styles.saveDisabled]}
      onPress={onSave}
      disabled={!onSave}
      testID="sense-grounding-save"
      accessibilityRole="button"
      accessibilityLabel="Save session and reflect"
      accessibilityState={{ disabled: !onSave }}
    >
      <Text style={styles.saveText}>Save session</Text>
    </Pressable>
  </View>
);

interface ActivePromptProps {
  prompt: SensePrompt;
  canAdvance: boolean;
  onTap: () => void;
}

const ActivePrompt = ({ prompt, canAdvance, onTap }: ActivePromptProps): React.JSX.Element => (
  <>
    <Text style={styles.prompt} testID="sense-grounding-prompt">
      {prompt.label}
    </Text>
    <Pressable
      style={[styles.advance, !canAdvance && styles.advanceDisabled]}
      onPress={canAdvance ? onTap : undefined}
      disabled={!canAdvance}
      testID="sense-grounding-advance"
      accessibilityRole="button"
      accessibilityLabel={`Mark ${prompt.sense} done`}
      accessibilityState={{ disabled: !canAdvance }}
    >
      <Text style={styles.advanceText}>{`Mark ${prompt.sense} done`}</Text>
    </Pressable>
  </>
);

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
  count: {
    fontSize: 18,
    color: colors.text.secondaryAccessible,
  },
  countVerb: {
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

export default SenseGroundingView;
