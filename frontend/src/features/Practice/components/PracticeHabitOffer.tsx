import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import OfferAction from './PracticeHabitAction';

import { SPACING, editorialType, onShowcase } from '@/design/tokens';
import {
  loadPracticeHabitOfferAnswered,
  savePracticeHabitOfferAnswered,
} from '@/storage/practiceHabitOfferStorage';
import { getActiveUser, getActiveUserGeneration } from '@/storage/userScope';

interface OfferProps {
  adoptionId: number;
  onLink: () => void;
}

/** Mount after a confirmed completed sitting, only while this practice has no linked habit. */
export default function PracticeHabitOffer({
  adoptionId,
  onLink,
}: OfferProps): React.JSX.Element | null {
  const owner = getActiveUser();
  const generation = getActiveUserGeneration();
  const identity = `${generation}:${owner}:${adoptionId}`;
  const live = useRef({ identity, mounted: true });
  live.current.identity = identity;
  useEffect(() => {
    const instance = live.current;
    instance.mounted = true;
    return () => {
      instance.mounted = false;
    };
  }, []);
  const [answerState, setAnswerState] = useState<{
    identity: string;
    answered: boolean | null;
  } | null>(null);
  useEffect(() => {
    let active = true;
    void loadPracticeHabitOfferAnswered(adoptionId, owner).then((value) => {
      if (active && getActiveUser() === owner && getActiveUserGeneration() === generation)
        setAnswerState({ identity, answered: value });
    });
    return () => {
      active = false;
    };
  }, [adoptionId, owner, generation, identity]);
  const answer = (link: boolean): void => {
    if (
      !live.current.mounted ||
      live.current.identity !== identity ||
      getActiveUser() !== owner ||
      owner === null ||
      getActiveUserGeneration() !== generation
    )
      return;
    setAnswerState({ identity, answered: true });
    void savePracticeHabitOfferAnswered(adoptionId, owner);
    if (link) onLink();
  };
  if (answerState?.identity !== identity || answerState.answered !== false) return null;
  return <Invitation answer={answer} />;
}

function Invitation({ answer }: { answer: (_link: boolean) => void }): React.JSX.Element {
  return (
    <View style={styles.offer} testID="practice-habit-offer">
      <Text style={styles.copy}>Would you like completed sessions to count toward a habit?</Text>
      <OfferAction
        label="Link a habit"
        testID="practice-habit-offer-link"
        a11yLabel="Choose a habit for this practice"
        onPress={() => answer(true)}
      />
      <OfferAction
        label="Maybe later"
        testID="practice-habit-offer-decline"
        a11yLabel="Decline the habit invitation for this practice"
        onPress={() => answer(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  offer: { gap: SPACING.xs, paddingVertical: SPACING.md },
  copy: { ...editorialType.caption, color: onShowcase.soft },
});
