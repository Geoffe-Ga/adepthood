import React, { useEffect, useState } from 'react';
import { Text, TouchableOpacity } from 'react-native';

import { course as courseApi, type StageIntro } from '../../api';

import styles from './Course.styles';

interface StageIntroCardProps {
  stageNumber: number;
  onOpen: (_stageNumber: number) => void;
}

/**
 * "Start here" card for a stage's course introduction, shown above the chapter
 * list. Loads its own intro and refetches on stage change. A missing intro
 * (404 — no intro authored, or the stage is locked) is a NORMAL state, not an
 * error: the card simply renders nothing, mirroring ``SiteResourcesPanel``.
 * Tapping opens the intro in the native ``ChapterReader`` via ``onOpen``.
 */
const StageIntroCard = ({ stageNumber, onOpen }: StageIntroCardProps): React.JSX.Element | null => {
  const [intro, setIntro] = useState<StageIntro | null>(null);

  useEffect(() => {
    let active = true;
    // Reset immediately so a previous stage's intro never lingers while the
    // new one loads (or while the new stage has none).
    setIntro(null);
    courseApi
      .stageIntro(stageNumber)
      .then((result) => {
        if (active) setIntro(result);
      })
      .catch((err: unknown) => {
        // No intro / locked stage is expected — keep the card hidden, no banner.
        console.warn('No stage introduction:', err);
      });
    return () => {
      active = false;
    };
  }, [stageNumber]);

  if (!intro) return null;

  return (
    <TouchableOpacity
      testID="stage-intro-card"
      style={styles.introCard}
      onPress={() => onOpen(stageNumber)}
      accessibilityRole="button"
      accessibilityLabel={`Open the ${intro.title} introduction`}
    >
      <Text style={styles.introCardLabel}>Introduction</Text>
      <Text style={styles.introCardTitle}>{intro.title}</Text>
      {intro.summary ? <Text style={styles.introCardSummary}>{intro.summary}</Text> : null}
    </TouchableOpacity>
  );
};

export default StageIntroCard;
