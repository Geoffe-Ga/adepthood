import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { decompose, totalSteps } from '../engine/tallied';
import type { TalliedPosition } from '../engine/tallied';
import type { RitualControls, RitualState, TalliedGroundingConfig } from '../engine/types';

import RitualControlsBar from './RitualControlsBar';
import type { SessionSurface } from './sessionSurface';
import { useSessionSurface } from './sessionSurface';
import {
  GroundingCompleteCard,
  SessionContainer,
  SessionCtaButton,
  groundingHeaderStyles,
} from './shared';

import { SPACING } from '@/design/tokens';

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
  const surface = useSessionSurface();
  const total = totalSteps(config);
  const isComplete = state.status === 'complete' || state.currentStepIndex >= total;
  // Skip the decomposition entirely once complete — the result would be unused.
  const position = isComplete ? null : decompose(state.currentStepIndex, config);
  const canAdvance = state.status === 'running' && !isComplete;
  return (
    <SessionContainer testID="tallied-grounding-view">
      <TalliedHeader config={config} position={position} surface={surface} />
      {position === null ? (
        <GroundingCompleteCard
          body="You tallied every round. Save the session below."
          testID="tallied-grounding-complete"
          saveTestID="tallied-grounding-save"
          onSave={onSave}
          surface={surface}
        />
      ) : (
        <ActivePrompt
          position={position}
          canAdvance={canAdvance}
          onTap={controls.tap}
          surface={surface}
        />
      )}
      <RitualControlsBar status={state.status} controls={controls} startLabel="Begin grounding" />
    </SessionContainer>
  );
};

interface HeaderProps {
  config: TalliedGroundingConfig;
  position: TalliedPosition | null;
  surface: SessionSurface;
}

const TalliedHeader = ({ config, position, surface }: HeaderProps): React.JSX.Element => (
  <View
    style={groundingHeaderStyles.header}
    testID="tallied-grounding-header"
    accessibilityRole="header"
    accessibilityLabel="Tallied grounding"
  >
    <Text
      style={[groundingHeaderStyles.badge, { color: surface.text }]}
      testID="tallied-grounding-badge"
    >
      {`${config.categories.length} × ${config.rounds}`}
    </Text>
    {position && (
      <Text style={[styles.round, { color: surface.text }]} testID="tallied-grounding-round">
        {`Round ${position.roundIndex + 1} of ${config.rounds}`}
      </Text>
    )}
  </View>
);

interface ActivePromptProps {
  position: TalliedPosition;
  canAdvance: boolean;
  onTap: () => void;
  surface: SessionSurface;
}

const ActivePrompt = ({
  position,
  canAdvance,
  onTap,
  surface,
}: ActivePromptProps): React.JSX.Element => {
  const { category, itemInCategory } = position;
  const promptText = `Find ${category.label} (${itemInCategory + 1} of ${category.target_count})`;
  return (
    <>
      <Text style={[styles.prompt, { color: surface.text }]} testID="tallied-grounding-prompt">
        {promptText}
      </Text>
      <SessionCtaButton
        label="I found one"
        accessibilityLabel={`Tally ${category.label}`}
        disabled={!canAdvance}
        onPress={onTap}
        testID="tallied-grounding-advance"
        style={{ marginBottom: SPACING.xl }}
        accessibilityState={{ disabled: !canAdvance }}
      />
    </>
  );
};

const styles = StyleSheet.create({
  round: {
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: 2,
  },
  prompt: {
    fontSize: 20,
    fontWeight: '500',
    textAlign: 'center',
    marginBottom: SPACING.xxl,
    paddingHorizontal: SPACING.lg,
  },
});

export default TalliedGroundingView;
