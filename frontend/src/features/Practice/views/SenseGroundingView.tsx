import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type {
  RitualControls,
  RitualState,
  SenseGroundingConfig,
  SenseKind,
  SensePrompt,
} from '../engine/types';

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
  const surface = useSessionSurface();
  const total = config.prompts.length;
  const currentIdx = Math.min(state.currentStepIndex, total - 1);
  const activePrompt = config.prompts[currentIdx];
  const isComplete = state.status === 'complete' || state.currentStepIndex >= total;
  // Show the advance button only once started; idle shows a primer instead of a dead button.
  const inProgress = (state.status === 'running' || state.status === 'paused') && !isComplete;
  return (
    <SessionContainer testID="sense-grounding-view">
      <SenseHeader prompt={inProgress ? activePrompt : null} surface={surface} />
      <SenseBody
        isComplete={isComplete}
        inProgress={inProgress}
        prompt={activePrompt}
        canAdvance={state.status === 'running' && !isComplete}
        onTap={controls.tap}
        onSave={onSave}
        surface={surface}
      />
      <RitualControlsBar status={state.status} controls={controls} startLabel="Begin grounding" />
    </SessionContainer>
  );
};

interface SenseBodyProps {
  isComplete: boolean;
  inProgress: boolean;
  prompt: SensePrompt | undefined;
  canAdvance: boolean;
  onTap: () => void;
  onSave?: () => void;
  surface: SessionSurface;
}

/** The middle of the card: completion summary, live prompt, or idle primer. */
const SenseBody = ({
  isComplete,
  inProgress,
  prompt,
  canAdvance,
  onTap,
  onSave,
  surface,
}: SenseBodyProps): React.JSX.Element => {
  if (isComplete) {
    return (
      <GroundingCompleteCard
        body="You moved through all five senses. Save the session below."
        testID="sense-grounding-complete"
        saveTestID="sense-grounding-save"
        onSave={onSave}
        surface={surface}
      />
    );
  }
  if (inProgress && prompt) {
    return <AdvanceButton sense={prompt.sense} canAdvance={canAdvance} onTap={onTap} />;
  }
  return (
    <Text style={[styles.intro, { color: surface.textSoft }]} testID="sense-grounding-intro">
      Move through your five senses, one at a time, to settle into the present moment.
    </Text>
  );
};

interface SenseHeaderProps {
  prompt: SensePrompt | null | undefined;
  surface: SessionSurface;
}

const SenseHeader = ({ prompt, surface }: SenseHeaderProps): React.JSX.Element => (
  <View
    style={groundingHeaderStyles.header}
    testID="sense-grounding-header"
    accessibilityRole="header"
    accessibilityLabel="5-4-3-2-1 grounding"
  >
    <Text
      style={[groundingHeaderStyles.badge, { color: surface.text }]}
      testID="sense-grounding-badge"
    >
      5-4-3-2-1
    </Text>
    {prompt && (
      <Text style={[styles.count, { color: surface.textSoft }]} testID="sense-grounding-count">
        {`${SENSE_COUNT[prompt.sense]} things you can `}
        <Text style={[styles.countVerb, { color: surface.text }]}>{SENSE_VERB[prompt.sense]}</Text>
      </Text>
    )}
  </View>
);

interface AdvanceButtonProps {
  sense: SenseKind;
  canAdvance: boolean;
  onTap: () => void;
}

const AdvanceButton = ({ sense, canAdvance, onTap }: AdvanceButtonProps): React.JSX.Element => (
  <SessionCtaButton
    label={`Mark ${sense} done`}
    accessibilityLabel={`Mark ${sense} done`}
    disabled={!canAdvance}
    onPress={onTap}
    testID="sense-grounding-advance"
    style={{ marginBottom: SPACING.xl }}
    accessibilityState={{ disabled: !canAdvance }}
  />
);

const styles = StyleSheet.create({
  count: {
    fontSize: 18,
  },
  countVerb: {
    fontWeight: '700',
    letterSpacing: 2,
  },
  intro: {
    fontSize: 16,
    textAlign: 'center',
    marginBottom: SPACING.xxl,
    paddingHorizontal: SPACING.lg,
    lineHeight: 24,
  },
});

export default SenseGroundingView;
