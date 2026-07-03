import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { useNavigation } from '@react-navigation/native';
import React from 'react';
import { Animated, Pressable, Text } from 'react-native';

import { journalHeroStyles as s } from './JournalHero.styles';

import { ShowcaseCard } from '@/components/layout/ShowcaseCard';
import { STAGE_ORDER } from '@/design/tokens';
import { useEntrance } from '@/hooks/useEntrance';
import type { RootTabParamList } from '@/navigation/BottomTabs';
import {
  TOTAL_PROGRAM_WEEKS,
  programStage,
  programWeek,
  selectProgramStartDate,
  useProgramStore,
} from '@/store/useProgramStore';
import { greeting } from '@/utils/greeting';

type JournalHeroNav = BottomTabNavigationProp<RootTabParamList>;

const MAP_HINT = 'Open the map';

interface HeroPosition {
  text: string;
  label: string;
}

/** Pair a position line with an a11y label that names its map-opening action. */
function withMapHint(text: string): HeroPosition {
  return { text, label: `${text}. ${MAP_HINT}` };
}

/** The reader's place in the 36-week journey, as display text + a11y label. */
function heroPosition(week: number | null, stage: number | null): HeroPosition {
  if (week === null) return withMapHint('Your journey awaits');
  const base = `Week ${week} of ${TOTAL_PROGRAM_WEEKS}`;
  if (stage === null) return withMapHint(base);
  const stageName = STAGE_ORDER[stage - 1];
  if (stageName === undefined) return withMapHint(base);
  return withMapHint(`${base} · ${stageName}`);
}

/** The journal showcase hero: greeting + a tappable position that opens the map. */
const JournalHero = (): React.JSX.Element => {
  const navigation = useNavigation<JournalHeroNav>();
  const anchor = useProgramStore(selectProgramStartDate);
  const week = programWeek(anchor);
  const stage = programStage(anchor);
  const entrance = useEntrance(0);
  const { text, label } = heroPosition(week, stage);
  return (
    <Animated.View style={entrance}>
      <ShowcaseCard testID="journal-hero">
        <Text style={s.eyebrow}>Today</Text>
        <Text style={s.greeting} accessibilityRole="header">
          {greeting()}
        </Text>
        <Pressable
          style={s.position}
          onPress={() => navigation.navigate('Map')}
          accessibilityRole="button"
          accessibilityLabel={label}
          testID="journal-hero-position"
        >
          <Text style={s.positionText}>{text}</Text>
          <Text style={s.positionCue}>{MAP_HINT} →</Text>
        </Pressable>
      </ShowcaseCard>
    </Animated.View>
  );
};

export default JournalHero;
