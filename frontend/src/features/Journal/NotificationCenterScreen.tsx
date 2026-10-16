/**
 * ``NotificationCenterScreen`` (#3142) — one quiet inbox for the prompts,
 * reminders and progress that sit above the fold on the Journal home, so that
 * the start screen can come to hold only the page the writer came to write.
 *
 * Reached by a door the writer opens: the home's "Notifications" button or the
 * Journal drawer's row. It stacks, in order, the stat tiles, Return (behind the
 * habits ring, as on the home), the invitations (which filter themselves by
 * ring), this stage's prompts, and the voice-readiness band. Each section keeps
 * its own data and its own one-tap decline; a plain editorial heading appears
 * only over a section that has something to show, and when no item waits the
 * screen says so once, in the note face, and nothing more.
 */
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  NotificationPresenceProvider,
  usePresenceTally,
  type NotificationSlot,
} from './notificationPresence';
import StagePromptSection, {
  useOpenStagePrompt,
  useStagePromptPlace,
  useStagePrompts,
  visibleStagePromptCount,
} from './StagePromptSection';
import StatTileRow from './StatTileRow';
import VoiceReadinessBand from './VoiceReadinessBand';

import { ScreenScaffold } from '@/components/layout/ScreenScaffold';
import { editorialType, ink, rhythm } from '@/design/tokens';
import DepthGate from '@/features/Depth/DepthGate';
import InvitationStack from '@/features/Invitations/InvitationStack';
import ReturnStack from '@/features/Return/ReturnStack';
import type { RootStackParamList } from '@/navigation/RootStack';

/** The section headings, plain words in the order the sections stack. */
export const NOTIFICATION_CENTER_HEADINGS = {
  today: 'Today',
  return: 'Return',
  invitations: 'Invitations',
  prompts: "This week's prompts",
  voice: 'Your voice',
} as const;

/** Said once when no item waits — a fact, not an achievement and not a nudge. */
export const NOTIFICATION_CENTER_EMPTY = 'Nothing waiting.';

/**
 * How long the screen lets its sections load before "Nothing waiting." may
 * show. Every section starts empty while its read is in flight, so without a
 * pause the note would greet a writer with items on the way and then vanish
 * under them. Long enough for the shelf's ordinary reads; a slower network
 * still sees the note only once it has been true for this long.
 */
export const EMPTY_SETTLE_MS = 1500;

type CenterNavigation = NativeStackNavigationProp<RootStackParamList>;

/** False until ``ms`` has passed since mount. */
function useSettled(ms: number): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(true), ms);
    return () => clearTimeout(timer);
  }, [ms]);
  return settled;
}

/** A section heading, rendered only while its section has something to show. */
function SectionHeading({
  shown,
  title,
}: {
  shown: boolean;
  title: string;
}): React.JSX.Element | null {
  if (!shown) return null;
  return (
    <Text style={styles.sectionHeading} accessibilityRole="header">
      {title}
    </Text>
  );
}

/** A reporting section beneath its heading. */
function Section({
  slot,
  visible,
  children,
}: {
  slot: NotificationSlot;
  visible: (_slot: NotificationSlot) => boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <View testID={`journal-notification-section-${slot}`}>
      <SectionHeading shown={visible(slot)} title={NOTIFICATION_CENTER_HEADINGS[slot]} />
      {children}
    </View>
  );
}

function NotificationCenterScreen(): React.JSX.Element {
  const navigation = useNavigation<CenterNavigation>();
  const { week, stage } = useStagePromptPlace();
  const stagePrompts = useStagePrompts(stage, week);
  const openPrompt = useOpenStagePrompt(navigation, week);
  const tally = usePresenceTally();
  const promptsShown = stagePrompts.stage !== null && stagePrompts.stage.prompts.length > 0;
  const waiting = tally.count + visibleStagePromptCount(stagePrompts);
  const settled = useSettled(EMPTY_SETTLE_MS);

  return (
    <ScreenScaffold scroll testID="journal-notification-center">
      <NotificationPresenceProvider value={tally.report}>
        <Section slot="today" visible={tally.isVisible}>
          <StatTileRow />
        </Section>
        <Section slot="return" visible={tally.isVisible}>
          {/* Return is a way back into habits, so a declined habits ring quiets
              it here exactly as on the home (#3073). */}
          <DepthGate ring="habits">
            <ReturnStack />
          </DepthGate>
        </Section>
        <Section slot="invitations" visible={tally.isVisible}>
          <InvitationStack />
        </Section>
        <View testID="journal-notification-section-prompts">
          <SectionHeading shown={promptsShown} title={NOTIFICATION_CENTER_HEADINGS.prompts} />
          <StagePromptSection band={stagePrompts} onOpen={openPrompt} />
        </View>
        <Section slot="voice" visible={tally.isVisible}>
          <VoiceReadinessBand />
        </Section>
      </NotificationPresenceProvider>
      {settled && waiting === 0 ? (
        <Text style={styles.empty} testID="journal-notification-center-empty">
          {NOTIFICATION_CENTER_EMPTY}
        </Text>
      ) : null}
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  sectionHeading: {
    // The EditorialSection voice: a serif heading in ink, a section gap above.
    ...editorialType.heading,
    color: ink.primary,
    marginTop: rhythm.sectionGap,
    marginBottom: rhythm.blockGap,
  },
  empty: {
    ...editorialType.note,
    color: ink.soft,
    marginTop: rhythm.sectionGap,
  },
});

export default NotificationCenterScreen;
