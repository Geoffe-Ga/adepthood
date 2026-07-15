import React, { useCallback, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { welcomeStyles as s } from './Welcome.styles';
import { WELCOME_PANELS, type WelcomePanel } from './welcomeContent';

import { CalloutBand } from '@/components/layout/CalloutBand';
import { ShowcaseCard } from '@/components/layout/ShowcaseCard';
import { useReducedMotion } from '@/hooks/useReducedMotion';

interface PanelProps {
  panel: WelcomePanel;
  index: number;
  width: number;
}

/** A single editorial panel rendered as a ShowcaseCard hero. */
const WelcomePanelView = ({ panel, index, width }: PanelProps): React.JSX.Element => (
  <View style={[s.panel, { width }]} testID={`welcome-panel-${index}`}>
    <ShowcaseCard>
      <View style={s.hero}>
        <Text style={s.eyebrow}>{panel.eyebrow}</Text>
        <Text style={s.title} accessibilityRole="header">
          {panel.title}
        </Text>
        <Text style={s.body}>{panel.body}</Text>
        {panel.pillars ? (
          <View style={s.pillars}>
            {panel.pillars.map((pillar) => (
              <View key={pillar.name} style={s.pillarRow}>
                <Text style={s.pillarGlyph}>{pillar.glyph}</Text>
                <Text style={s.pillarName}>{pillar.name}</Text>
              </View>
            ))}
          </View>
        ) : null}
        {panel.note ? (
          <Text style={s.note} testID="welcome-privacy-note">
            {panel.note}
          </Text>
        ) : null}
      </View>
    </ShowcaseCard>
  </View>
);

interface DotsProps {
  count: number;
  active: number;
}

/** Page-position indicator; non-interactive so paging stays the single seam. */
const PagerDots = ({ count, active }: DotsProps): React.JSX.Element => (
  <View style={s.dots} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    {Array.from({ length: count }, (_, i) => (
      <View key={i} style={[s.dot, i === active ? s.dotActive : undefined]} />
    ))}
  </View>
);

/** Persistent Skip affordance shown on every panel. */
const SkipButton = ({ onSkip }: { onSkip: () => void }): React.JSX.Element => (
  <View style={s.header}>
    <Pressable
      onPress={onSkip}
      style={s.skip}
      accessibilityRole="button"
      accessibilityLabel="Skip the welcome"
      testID="welcome-skip"
    >
      <Text style={s.skipLabel}>Skip</Text>
    </Pressable>
  </View>
);

interface FooterProps {
  page: number;
  isLast: boolean;
  onNext: () => void;
  onBegin: () => void;
}

/** Page dots plus the contextual Next / Begin control. */
const WelcomeFooter = ({ page, isLast, onNext, onBegin }: FooterProps): React.JSX.Element => (
  <View style={s.footer}>
    <PagerDots count={WELCOME_PANELS.length} active={page} />
    {isLast ? (
      <CalloutBand
        label="Begin"
        onPress={onBegin}
        accessibilityLabel="Begin the journey"
        testID="welcome-begin"
      />
    ) : (
      <Pressable
        onPress={onNext}
        style={s.nextButton}
        accessibilityRole="button"
        accessibilityLabel="Next panel"
        testID="welcome-next"
      >
        <Text style={s.nextLabel}>Next</Text>
      </Pressable>
    )}
  </View>
);

interface Pager {
  page: number;
  width: number;
  scrollRef: React.RefObject<ScrollView>;
  onScroll: (_e: NativeSyntheticEvent<NativeScrollEvent>) => void;
  goNext: () => void;
}

/** Reduced-motion-safe horizontal paging state for the welcome panels. */
const useWelcomePager = (): Pager => {
  const { width } = useWindowDimensions();
  const reduced = useReducedMotion();
  const scrollRef = useRef<ScrollView>(null);
  const [page, setPage] = useState(0);
  const lastIndex = WELCOME_PANELS.length - 1;

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      setPage(Math.round(e.nativeEvent.contentOffset.x / Math.max(width, 1)));
    },
    [width],
  );

  const goNext = useCallback(() => {
    const next = Math.min(page + 1, lastIndex);
    setPage(next);
    scrollRef.current?.scrollTo({ x: next * width, animated: !reduced });
  }, [page, lastIndex, width, reduced]);

  return { page, width, scrollRef, onScroll, goNext };
};

export interface WelcomeScreenProps {
  /** Persist the flag and dismiss the welcome (called on Begin and Skip). */
  onComplete: () => void;
  /** Land on the Journal home, optionally opening the first-habits step. */
  onBegin: () => void;
}

/**
 * The program welcome (#836): a swipeable editorial intro to the 36-week
 * journey. Paging works with or without animation (reduced-motion-safe), a
 * persistent Skip sits on every panel, and the final panel's Begin CTA lands
 * the user on the Journal home (the app shell's initial route).
 */
export const WelcomeScreen = ({ onComplete, onBegin }: WelcomeScreenProps): React.JSX.Element => {
  const { page, width, scrollRef, onScroll, goNext } = useWelcomePager();
  const begin = useCallback(() => {
    onComplete();
    onBegin();
  }, [onComplete, onBegin]);

  return (
    <SafeAreaView style={s.ground} testID="welcome-screen">
      <SkipButton onSkip={onComplete} />
      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onScroll}
        testID="welcome-pager"
      >
        {WELCOME_PANELS.map((panel, index) => (
          <WelcomePanelView key={panel.title} panel={panel} index={index} width={width} />
        ))}
      </ScrollView>
      <WelcomeFooter
        page={page}
        isLast={page === WELCOME_PANELS.length - 1}
        onNext={goNext}
        onBegin={begin}
      />
    </SafeAreaView>
  );
};

export default WelcomeScreen;
