/**
 * ``MettaSessionModal`` — the guided loving-kindness session launched from the
 * Return arc. A three-phase local machine (idle -> running -> rest) walks the
 * person through the current week's focus phrases. Wholly optional: a close
 * affordance sits in every phase, closing issues no network call and mutates no
 * arc or stage state. Reduced-motion-safe; tokens only.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import {
  METTA_SESSION_ADVANCE,
  METTA_SESSION_ADVANCE_A11Y,
  METTA_SESSION_BEGIN,
  METTA_SESSION_BEGIN_A11Y,
  METTA_SESSION_CLOSE,
  METTA_SESSION_CLOSE_A11Y,
  METTA_SESSION_HEADING,
  METTA_SESSION_PHRASES,
  METTA_SESSION_REST,
} from './mettaSessionCopy';

import type { ReturnWeek } from '@/api';
import {
  BORDER_RADIUS,
  SPACING,
  colors,
  editorialType,
  spacing,
  touchTarget,
} from '@/design/tokens';
import { CALM_SURFACE, SessionSurfaceProvider } from '@/features/Practice/views/sessionSurface';
import { SessionContainer, SessionCtaButton } from '@/features/Practice/views/shared';
import { useReducedMotion } from '@/hooks/useReducedMotion';

/** The first phrase index — a running session always opens on the opening wish. */
const FIRST_PHRASE = 0;

/** Stand-in when no phrase is active (the idle and rest phases never read it). */
const NO_PHRASE = '';

type Phase = 'idle' | 'running' | 'rest';

export interface MettaSessionModalProps {
  visible: boolean;
  focus: ReturnWeek['focus'];
  weekTitle?: string;
  onClose: () => void;
}

interface MettaSession {
  phase: Phase;
  phrase: string;
  begin: () => void;
  advance: () => void;
}

/** The three-phase session machine: idle opening, phrase walk, then rest. */
function useMettaSession(visible: boolean, focus: ReturnWeek['focus']): MettaSession {
  const [phase, setPhase] = useState<Phase>('idle');
  const [index, setIndex] = useState(FIRST_PHRASE);
  const phrases = METTA_SESSION_PHRASES[focus];

  // Re-opening the session always returns to the idle opening screen.
  useEffect(() => {
    if (visible) {
      setPhase('idle');
      setIndex(FIRST_PHRASE);
    }
  }, [visible]);

  const begin = useCallback(() => {
    setIndex(FIRST_PHRASE);
    setPhase('running');
  }, []);

  const advance = useCallback(() => {
    const next = index + 1;
    if (next >= phrases.length) {
      setPhase('rest');
    } else {
      setIndex(next);
    }
  }, [index, phrases]);

  return { phase, phrase: phrases[index] ?? NO_PHRASE, begin, advance };
}

/** The opening screen: heading, optional week title, and the begin affordance. */
function IdlePhase({
  weekTitle,
  onBegin,
}: {
  weekTitle?: string;
  onBegin: () => void;
}): React.JSX.Element {
  return (
    <>
      <Text style={styles.heading}>{METTA_SESSION_HEADING}</Text>
      {weekTitle ? <Text style={styles.weekTitle}>{weekTitle}</Text> : null}
      <SessionCtaButton
        label={METTA_SESSION_BEGIN}
        onPress={onBegin}
        testID="metta-session-begin"
        accessibilityLabel={METTA_SESSION_BEGIN_A11Y}
      />
    </>
  );
}

/** The running screen: the current phrase and the advance affordance. */
function RunningPhase({
  phrase,
  onAdvance,
}: {
  phrase: string;
  onAdvance: () => void;
}): React.JSX.Element {
  return (
    <>
      <Text style={styles.phrase}>{phrase}</Text>
      <SessionCtaButton
        label={METTA_SESSION_ADVANCE}
        onPress={onAdvance}
        testID="metta-session-advance"
        accessibilityLabel={METTA_SESSION_ADVANCE_A11Y}
      />
    </>
  );
}

/** The quiet close affordance, present in every phase. */
function CloseButton({ onClose }: { onClose: () => void }): React.JSX.Element {
  return (
    <TouchableOpacity
      style={styles.close}
      onPress={onClose}
      accessibilityRole="button"
      accessibilityLabel={METTA_SESSION_CLOSE_A11Y}
      testID="metta-session-close"
    >
      <Text style={styles.closeText}>{METTA_SESSION_CLOSE}</Text>
    </TouchableOpacity>
  );
}

/** Pick the phase body — idle by default, running mid-session, rest at the end. */
function SessionBody({
  phase,
  phrase,
  weekTitle,
  onBegin,
  onAdvance,
}: {
  phase: Phase;
  phrase: string;
  weekTitle?: string;
  onBegin: () => void;
  onAdvance: () => void;
}): React.JSX.Element {
  if (phase === 'running') {
    return <RunningPhase phrase={phrase} onAdvance={onAdvance} />;
  }
  if (phase === 'rest') {
    return <Text style={styles.rest}>{METTA_SESSION_REST}</Text>;
  }
  return <IdlePhase weekTitle={weekTitle} onBegin={onBegin} />;
}

function MettaSessionModal({
  visible,
  focus,
  weekTitle,
  onClose,
}: MettaSessionModalProps): React.JSX.Element {
  const reducedMotion = useReducedMotion();
  const { phase, phrase, begin, advance } = useMettaSession(visible, focus);
  return (
    <Modal
      visible={visible}
      transparent
      animationType={reducedMotion ? 'none' : 'fade'}
      onRequestClose={onClose}
      testID="metta-session-modal"
    >
      <View style={styles.scrim}>
        <SessionSurfaceProvider value={CALM_SURFACE}>
          <SessionContainer testID="metta-session-container" style={styles.card}>
            <SessionBody
              phase={phase}
              phrase={phrase}
              weekTitle={weekTitle}
              onBegin={begin}
              onAdvance={advance}
            />
            <CloseButton onClose={onClose} />
          </SessionContainer>
        </SessionSurfaceProvider>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: colors.mystical.overlay,
    justifyContent: 'center',
    paddingHorizontal: SPACING.xl,
  },
  card: {
    borderRadius: BORDER_RADIUS.lg,
  },
  heading: {
    ...editorialType.title,
    color: colors.paper.ink,
    textAlign: 'center',
    marginBottom: spacing(1),
  },
  weekTitle: {
    ...editorialType.caption,
    color: colors.paper.inkSoft,
    textAlign: 'center',
    marginBottom: spacing(2),
  },
  phrase: {
    ...editorialType.title,
    color: colors.paper.ink,
    textAlign: 'center',
    marginBottom: spacing(2.5),
  },
  rest: {
    ...editorialType.body,
    color: colors.paper.ink,
    textAlign: 'center',
    marginBottom: spacing(2),
  },
  close: {
    minHeight: touchTarget.minimum,
    minWidth: touchTarget.minimum,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    marginTop: spacing(1.5),
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: {
    ...editorialType.action,
    color: colors.paper.inkSoft,
  },
});

export default MettaSessionModal;
