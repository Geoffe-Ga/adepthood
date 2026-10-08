import type { NavigatorScreenParams } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import React from 'react';

import AdminFeedbackScreen from '../features/AdminFeedback/AdminFeedbackScreen';
import FeedbackComposerScreen from '../features/Feedback/FeedbackComposerScreen';
import JournalEntryScreen from '../features/Journal/JournalEntryScreen';
import JournalPhotographScreen from '../features/Journal/JournalPhotographScreen';
import PromotedQuotesScreen from '../features/Journal/PromotedQuotesScreen';
import VoiceDraftsShelfScreen from '../features/Journal/VoiceDraftsShelfScreen';
import { CreatePracticeWizard } from '../features/Practice/screens/CreatePracticeWizard';
import { PracticeCatalogScreen } from '../features/Practice/screens/PracticeCatalogScreen';
import { PracticeDetailScreen } from '../features/Practice/screens/PracticeDetailScreen';
import SharePreviewScreen from '../features/Practice/screens/SharePreviewScreen';
import SeedCorpusScreen from '../features/Seed/SeedCorpusScreen';
import ApiKeySettingsScreen from '../features/Settings/ApiKeySettingsScreen';
import CorpusConsentScreen from '../features/Settings/CorpusConsentScreen';
import DeleteAccountScreen from '../features/Settings/DeleteAccountScreen';
import ExportDataScreen from '../features/Settings/ExportDataScreen';
import PrivateVaultActivationScreen from '../features/Settings/PrivateVaultActivationScreen';
import SettingsHubScreen from '../features/Settings/SettingsHubScreen';
import SupportCareScreen from '../features/Settings/SupportCareScreen';
import TimezoneSettingsScreen from '../features/Settings/TimezoneSettingsScreen';
import VaultSettingsScreen from '../features/Settings/VaultSettingsScreen';

import type { RootTabParamList } from './BottomTabs';
import BottomTabs from './BottomTabs';
import { NAV_SCREEN_OPTIONS } from './navScreenOptions';

import type { JournalClassification, ReflectionLevel } from '@/api';
import type { ModeConfig } from '@/features/Practice/engine/types';

export interface CreatePracticePrefill {
  config: ModeConfig;
  name?: string;
  description?: string;
  instructions?: string;
  duration?: number;
  stageNumber?: number | null;
}

/**
 * A part of Settings a caller can open it on (#3006): ``'writing-habit'`` opens
 * the writing-timer habit picker in place and brings its row into view.
 */
export type SettingsFocus = 'writing-habit';

export type RootStackParamList = {
  Tabs: NavigatorScreenParams<RootTabParamList>;
  Settings: { focus?: SettingsFocus } | undefined;
  SeedCorpus: undefined;
  CorpusConsent: undefined;
  ApiKeySettings: undefined;
  TimezoneSettings: undefined;
  DeleteAccount: undefined;
  ExportData: undefined;
  SupportCare: undefined;
  VaultSettings: undefined;
  VaultActivation: undefined;
  SharePreview: { token: string };
  PracticeDetail: { practiceId: number; assignError?: string };
  CreatePractice: { prefill?: CreatePracticePrefill } | undefined;
  Catalog: { stageNumber?: number } | undefined;
  /**
   * The beta feedback composer (#2898). Carries at most one stable control
   * token naming the entry point -- never text from the screen being left.
   */
  Feedback: { control?: string } | undefined;
  /** The shelf of expanded margin notes. No params: it is a place, not a query. */
  VoiceDrafts: undefined;
  /**
   * Every quote the writer has promoted, across entries (#2865).
   *
   * This was "a place, no params", and it still is one when opened from the
   * shelf. #2885 reverses that note on purpose: to fold a selection into the
   * review the writer came FROM, the screen has to know there is one, and a
   * route param is the only thing that survives the hop. It follows the
   * ``JournalPhotograph`` ``appendTo`` precedent exactly -- one opaque hand-off
   * token (see ``usePromotedQuoteHandoffStore``), never quote text and never an
   * entry id, and minted only while the entry is composing a review. Absent,
   * the screen offers no fold-in, only "Write a review with N quotes".
   */
  PromotedQuotes: { injectInto?: string } | undefined;
  /** The operator's beta feedback inbox (#2900). Server-gated; no params. */
  AdminFeedback: undefined;
  JournalPhotograph:
    | {
        /**
         * Append mode: the capture was opened from a journal entry already being
         * written, and this is the hand-off token that entry minted (see
         * ``useCapturedTranscriptStore``). The transcript is handed back to that
         * page instead of being saved as a new entry. Only the token rides here
         * — never the transcribed prose, and never any page image.
         */
        appendTo?: string;
      }
    | undefined;
  JournalEntry:
    | {
        entryId?: number;
        /** Pre-set the privacy tier of a fresh entry (the capture flow's intimate
         *  "Type it instead" offramp passes ``intimate``). Only the scalar tier is
         *  carried — never any page image. */
        classification?: JournalClassification;
        /** Set when arriving fresh from photograph capture: reads as "Saved" and
         *  offers resonance immediately, skipping the usual idle-after-typing wait. */
        justSaved?: boolean;
        weekNumber?: number;
        /** Which of the stage's prompts this page answers, 1-based. Omitted means
         *  the prompt the week itself draws, the long-standing week-keyed shape. */
        promptOrdinal?: number;
        promptQuestion?: string;
        practiceSessionId?: number;
        userPracticeId?: number;
        prefillTitle?: string;
        /** Reflection scope this page closes (7th-day reflection compose mode). */
        reflectionLevel?: ReflectionLevel;
        /** The scope key the reflection covers (e.g. ``c1:w14``); pairs with ``reflectionLevel``. */
        reflectionScopeKey?: string;
        /**
         * A hand-off token from the Promoted quotes screen's "Write a review
         * with N quotes" (#2885): the review collects the selection delivered
         * under it (``usePromotedQuoteHandoffStore``) and folds it in once,
         * after it has hydrated. Only the token rides here, never the quotes.
         */
        injectQuotes?: string;
        /** A passage folded in from the reader; seeds the body as a blockquote. */
        prefillQuote?: { text: string; sourceTitle: string };
        /**
         * A promoted quote the reader arrived to see (from the Promoted quotes
         * screen, #2865), as code-point offsets into the body -- the anchor
         * API's own units. Read mode scrolls it into view and underlines it; a
         * span that no longer matches a live quote (stale, or out of range)
         * opens the page at the top.
         */
        highlightSpan?: { start: number; end: number };
        /**
         * A timed writing session this page was OPENED in order to run — the
         * quick launch from a saved ``Journaling`` practice. The timer opens at
         * ``minutes`` and is already running, and the finished session is
         * recorded against ``userPracticeId``. That id is ``null`` when the
         * practice's stage is still ahead on the writer's calendar, where the
         * server would refuse the session (403 ``stage_locked``) — the page is
         * opened either way and nothing is sent. Distinct from the
         * ``userPracticeId`` above, which links a REFLECTION to a practice
         * rather than asking for a session to be recorded.
         */
        writingSession?: { minutes: number; userPracticeId: number | null };
        /**
         * Where "Back to reading" returns the writer. ``scrollOffset`` is
         * optional because only the passage-note hand-off knows one: a reflection
         * closes the reader before it leaves, so it returns to the content item
         * and the Course screen opens it at the top (an absent offset reads as 0).
         */
        returnTo?: {
          screen: 'Course';
          params: { stageNumber?: number; contentId: number; scrollOffset?: number };
        };
      }
    | undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

/**
 * Root stack for the authenticated app. Hosts the bottom-tabs shell plus
 * modal-style screens (e.g. BYOK API key settings, the practice share
 * preview screen deep-linked from another app) that should not live
 * inside any single tab.
 *
 * ``Tabs`` is typed as ``NavigatorScreenParams<RootTabParamList>`` (not
 * ``undefined``) so screens nested under it -- e.g. ``SharePreviewScreen``
 * forwarding the recipient back to the Practice tab after a successful
 * import -- can pass ``{ screen, params }`` through ``navigation.navigate``
 * with full type safety.
 */
/** The Journal routes pushed as siblings of the tab shell: the entry editor and
 *  the photograph-capture flow. Grouped in a fragment to keep ``RootStack`` lean. */
const JournalScreens = (): React.JSX.Element => (
  <>
    <Stack.Screen
      name="JournalEntry"
      component={JournalEntryScreen}
      options={{ title: 'Journal' }}
    />
    <Stack.Screen
      name="JournalPhotograph"
      component={JournalPhotographScreen}
      options={{ title: 'Photograph journal' }}
    />
    <Stack.Screen
      name="VoiceDrafts"
      component={VoiceDraftsShelfScreen}
      options={{ title: 'Voice drafts' }}
    />
    <Stack.Screen
      name="PromotedQuotes"
      component={PromotedQuotesScreen}
      options={{ title: 'Promoted quotes' }}
    />
  </>
);

/** The Settings hub and everything reachable from it, grouped the way the
 *  Journal routes are so ``RootStack`` stays readable as the hub grows. */
const SettingsScreens = (): React.JSX.Element => (
  <>
    <Stack.Screen name="Settings" component={SettingsHubScreen} options={{ title: 'Settings' }} />
    <Stack.Screen
      name="SeedCorpus"
      component={SeedCorpusScreen}
      options={{ title: 'Your writing' }}
    />
    <Stack.Screen
      name="CorpusConsent"
      component={CorpusConsentScreen}
      options={{ title: 'What reflections draw on' }}
    />
    <Stack.Screen
      name="ApiKeySettings"
      component={ApiKeySettingsScreen}
      options={{ title: 'API Key' }}
    />
    <Stack.Screen
      name="TimezoneSettings"
      component={TimezoneSettingsScreen}
      options={{ title: 'Time zone' }}
    />
    <Stack.Screen
      name="ExportData"
      component={ExportDataScreen}
      options={{ title: 'Export my data' }}
    />
    <Stack.Screen
      name="DeleteAccount"
      component={DeleteAccountScreen}
      options={{ title: 'Delete account' }}
    />
    <Stack.Screen
      name="SupportCare"
      component={SupportCareScreen}
      options={{ title: 'Support & care' }}
    />
  </>
);

const RootStack = (): React.JSX.Element => (
  <Stack.Navigator screenOptions={NAV_SCREEN_OPTIONS}>
    <Stack.Screen name="Tabs" component={BottomTabs} options={{ headerShown: false }} />
    {SettingsScreens()}
    <Stack.Screen
      name="VaultSettings"
      component={VaultSettingsScreen}
      options={{ title: 'Where your writing lives' }}
    />
    <Stack.Screen
      name="VaultActivation"
      component={PrivateVaultActivationScreen}
      options={{ title: 'Create managed vault' }}
    />
    <Stack.Screen
      name="SharePreview"
      component={SharePreviewScreen}
      options={{ title: 'Shared practice' }}
    />
    <Stack.Screen
      name="PracticeDetail"
      component={PracticeDetailScreen}
      options={{ title: 'Practice' }}
    />
    <Stack.Screen
      name="CreatePractice"
      component={CreatePracticeWizard}
      options={{ title: 'New practice' }}
    />
    <Stack.Screen
      name="Catalog"
      component={PracticeCatalogScreen}
      options={{ title: 'Practices' }}
    />
    {JournalScreens()}
    <Stack.Screen
      name="Feedback"
      component={FeedbackComposerScreen}
      options={{ title: 'Send feedback' }}
    />
    <Stack.Screen
      name="AdminFeedback"
      component={AdminFeedbackScreen}
      options={{ title: 'Beta feedback inbox' }}
    />
  </Stack.Navigator>
);

export default RootStack;
