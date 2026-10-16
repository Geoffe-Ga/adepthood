/**
 * ``StagePromptSection`` — the current stage's prompts as one band, with the
 * reversible "Set aside" / "Bring it back" choice on each card and the
 * per-visit "N set aside" reveal. Moved out of ``JournalShelfScreen`` (#3142)
 * so the Journal home and the Notification Center render the same band from the
 * same hooks; nothing about its behaviour changed in the move.
 *
 * ``useStagePromptPlace`` names where the reader is (week and stage) the way the
 * shelf always derived it, and ``useStagePrompts`` reads that stage's prompts on
 * every focus. ``visibleStagePromptCount`` is what the Notification Center's
 * count reads from a loaded band: the cards still offered, never the ones set
 * aside.
 */
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { ChevronRight } from 'lucide-react-native';
import React, { useCallback, useMemo, useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';

import styles from './JournalShelf.styles';
import ReflectionDismiss from './ReflectionDismiss';

import { prompts } from '@/api';
import type { PromptDetail, StagePromptDetail, StagePromptsResponse } from '@/api';
import { decorativeHidden } from '@/components/a11yHidden';
import { accent, uiType } from '@/design/tokens';
import type { RootStackParamList } from '@/navigation/RootStack';
import {
  programStage,
  programStageForWeek,
  programWeek,
  useProgramStore,
} from '@/store/useProgramStore';

// Said of a prompt already written to. Deliberately a note, not a reward: the
// prompt stays open because several of them are meant to be returned to.
const ANSWERED_NOTE = 'Answered';

// Said once the week holds its one response. The server keeps a single response
// per week, so this names the rhythm rather than reporting a refusal — the whole
// set stays readable, just not writable until the week turns over.
const WEEK_WRITTEN_NOTE = "This week's prompt is written — the next one opens next week.";

// Declining a prompt, said as a choice rather than as a failure to do it. Not
// "skip", not "dismiss", and never a count of what went unwritten: the depths
// are declinable invitations, so the way out of one is offered in the same
// register the invitation was.
const SET_ASIDE_LABEL = 'Set aside';
const SET_ASIDE_HINT = 'Set this prompt aside; you can bring it back later.';
const BRING_BACK_LABEL = 'Bring it back';
const BRING_BACK_HINT = 'Bring this prompt back; it will appear with the others again.';
const SHOW_SET_ASIDE_HINT = 'Show the prompts you have set aside';

/** The chevron beside the set-aside count, sized to its label's face. */
const SET_ASIDE_CHEVRON_SIZE = uiType.button.fontSize;

/**
 * "1 set aside" / "N set aside" — the count folds into the band's eyebrow row
 * (#2949): the eyebrow already says these are prompts, and the chevron says
 * it opens, so the label carries only the number. The full sentence is the
 * control's accessible name (``SHOW_SET_ASIDE_HINT``).
 */
function setAsideCountLabel(count: number): string {
  return `${count} set aside`;
}

/** The current week's prompt, or null while it loads (or after a load error).
 *
 * Read only to learn which program week a response belongs to — the cards below
 * come from the stage endpoint. Re-fetched on every focus (not just mount): the
 * shelf stays mounted while the user pushes to the entry screen, so a week that
 * turned over in between would otherwise keep composing against the old one.
 */
function useCurrentPrompt(): PromptDetail | null {
  const [prompt, setPrompt] = useState<PromptDetail | null>(null);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      void prompts
        .current()
        .then((p) => {
          if (active) setPrompt(p);
        })
        .catch(() => {
          // A prompt fetch failure shouldn't block the shelf; the week falls back.
        });
      return () => {
        active = false;
      };
    }, []),
  );
  return prompt;
}

/** Where the reader is in the program, or nulls while that is unknown. */
export interface StagePromptPlace {
  week: number | null;
  stage: number | null;
}

/**
 * The reader's program week and stage, as the shelf has always derived them.
 *
 * The local program anchor decides the week and stage when there is one; the
 * server's current week stands in until (and if) that anchor is set. With
 * neither — no anchor, and a refused ``/prompts/current`` — the place stays
 * null instead of falling back to week 1, because that guess would show
 * another stage's prompts and file the response under a week nobody is in.
 */
export function useStagePromptPlace(): StagePromptPlace {
  const prompt = useCurrentPrompt();
  const anchor = useProgramStore((s) => s.programStartDate);
  const week = programWeek(anchor) ?? prompt?.week_number ?? null;
  const stage = week === null ? null : (programStage(anchor) ?? programStageForWeek(week));
  return { week, stage };
}

/** A stage's prompts, plus the ordinals of the ones already written to. */
interface StagePromptsState {
  stage: StagePromptsResponse | null;
  answered: ReadonlySet<number>;
  /** False once this week already holds its one response.
   *
   * The server stores at most one response per (reader, week), whichever of the
   * stage's prompts it answers. Offering a second tap in the same week would
   * send the reader to a page whose every save is refused and whose writing is
   * therefore stored nowhere, so the band stops inviting one and says why.
   */
  writable: boolean;
}

/** The stage's prompts plus the two ways a reader changes what is offered. */
export interface StagePromptsBand extends StagePromptsState {
  /** Stop offering this prompt, reversibly. */
  setAside: (_ordinal: number) => void;
  /** Offer it again. */
  bringBack: (_ordinal: number) => void;
}

const NO_STAGE_PROMPTS: StagePromptsState = {
  stage: null,
  answered: new Set<number>(),
  writable: true,
};

/** Ordinals of *this* stage's prompts the reader has already answered.
 *
 * Read from the response history rather than from the stage payload, which
 * describes the curriculum and knows nothing about this reader. Ordinals repeat
 * across stages, so a stored response only counts when its week falls inside
 * this stage; a response with no ordinal predates individually addressable
 * prompts and is skipped rather than credited to a prompt it may not answer.
 */
function answeredOrdinals(items: readonly PromptDetail[], stage: number): ReadonlySet<number> {
  const answered = new Set<number>();
  for (const item of items) {
    const ordinal = item.prompt_ordinal;
    if (ordinal != null && programStageForWeek(item.week_number) === stage) answered.add(ordinal);
  }
  return answered;
}

/** The current stage's whole prompt set, re-read on focus.
 *
 * A stage the reader has not reached is refused server-side, and any refusal
 * simply hides the section — the shelf never fails to render because prompts
 * did not load. The history read is allowed to fail on its own: the prompts
 * still appear, merely unmarked and still writable, rather than vanishing
 * because one of two reads failed.
 */
export function useStagePrompts(stage: number | null, week: number | null): StagePromptsBand {
  const [state, setState] = useState<StagePromptsState>(NO_STAGE_PROMPTS);
  useFocusEffect(
    useCallback(() => {
      // Neither read fires until the reader's place is actually known: a guessed
      // week would fetch — and offer — some other stage's prompts.
      if (stage === null || week === null) return undefined;
      let active = true;
      const load = async (): Promise<void> => {
        // Read together, not in sequence: the history is only used to mark the
        // cards, so making it wait on the curriculum read would delay the whole
        // section behind a request nothing renders directly.
        const [stagePrompts, history] = await Promise.all([
          prompts.stage(stage),
          prompts.history().catch(() => null),
        ]);
        if (!active) return;
        const items = history?.items ?? [];
        setState({
          stage: stagePrompts,
          answered: answeredOrdinals(items, stage),
          writable: !items.some((item) => item.week_number === week),
        });
      };
      void load().catch(() => {
        // A prompt fetch failure shouldn't block the shelf; just hide the section.
      });
      return () => {
        active = false;
      };
    }, [stage, week]),
  );

  // The server answers each mutation with the whole band, so the reply *is*
  // the new state and there is nothing to reconcile.
  const applyStage = useCallback((fresh: StagePromptsResponse) => {
    setState((prev) => ({ ...prev, stage: fresh }));
  }, []);
  return { ...state, ...useStagePromptChoice(stage, applyStage) };
}

/** One of the two stage-scoped mutations, as the band's handler for it. */
type StagePromptMutation = (
  _stageNumber: number,
  _promptOrdinal: number,
) => Promise<StagePromptsResponse>;

/** Setting a prompt aside and bringing it back, bound to one stage.
 *
 * Both are the same shape and differ only in which route they call, so they
 * are built from one factory rather than written twice. Nothing is hidden
 * optimistically: a card that vanished on a request that failed would report a
 * preference the server never recorded, and the reader would find it back on
 * the next focus with no idea why. A refusal therefore leaves the band exactly
 * as it was, which is already the truth.
 */
function useStagePromptChoice(
  stage: number | null,
  applyStage: (_fresh: StagePromptsResponse) => void,
): Pick<StagePromptsBand, 'setAside' | 'bringBack'> {
  const handlerFor = useCallback(
    (mutate: StagePromptMutation) => (ordinal: number) => {
      if (stage === null) return;
      void mutate(stage, ordinal)
        .then(applyStage)
        .catch(() => {
          // Refused: the band already shows what the server still holds.
        });
    },
    [stage, applyStage],
  );
  return {
    setAside: useMemo(() => handlerFor(prompts.setAside), [handlerFor]),
    bringBack: useMemo(() => handlerFor(prompts.bringBack), [handlerFor]),
  };
}

/**
 * How many of a band's cards are still on offer: loaded prompts the reader has
 * not set aside. Zero until a stage has loaded, matching a section that renders
 * nothing until then.
 */
export function visibleStagePromptCount(band: Pick<StagePromptsState, 'stage'>): number {
  if (band.stage === null) return 0;
  return band.stage.prompts.filter((prompt) => prompt.dismissed !== true).length;
}

type PromptNavigation = Pick<NativeStackNavigationProp<RootStackParamList>, 'navigate'>;

/**
 * Compose against *this* prompt: its ordinal is what tells the server which of
 * the stage's prompts the page answers, and its own curriculum headline is the
 * title — the server owns both strings, so the client derives neither. A null
 * week means the reader's place is unknown, in which case no prompt card is on
 * screen to press; filing the page under a guessed week would be worse than
 * doing nothing.
 */
export function useOpenStagePrompt(
  navigation: PromptNavigation,
  week: number | null,
): (_prompt: StagePromptDetail) => void {
  return useCallback(
    (prompt: StagePromptDetail) => {
      if (week === null) return;
      navigation.navigate('JournalEntry', {
        weekNumber: week,
        promptOrdinal: prompt.ordinal,
        promptQuestion: prompt.body,
        prefillTitle: prompt.title,
      });
    },
    [navigation, week],
  );
}

/** What a prompt card says: the prompt, its cadence, and whether it is answered. */
function StagePromptFace({
  prompt,
  answered,
}: {
  prompt: StagePromptDetail;
  answered: boolean;
}): React.JSX.Element {
  const { ordinal, title, cadence } = prompt;
  return (
    <>
      <Text style={styles.promptQuestion}>{title}</Text>
      {cadence == null ? null : (
        <Text style={styles.promptLabel} testID={`journal-stage-prompt-cadence-${ordinal}`}>
          {cadence}
        </Text>
      )}
      {answered ? (
        <Text style={styles.promptAnswered} testID={`journal-stage-prompt-answered-${ordinal}`}>
          {ANSWERED_NOTE}
        </Text>
      ) : null}
    </>
  );
}

/** The prompt itself, as either a reading surface or a way into the page.
 *
 * Pressable only while the week can still take a response. Once it holds one,
 * the card is a plain reading surface rather than a button that leads to a page
 * the server refuses to save — the section says why just above it.
 */
function StagePromptBody({
  prompt,
  answered,
  writable,
  onOpen,
}: {
  prompt: StagePromptDetail;
  answered: boolean;
  writable: boolean;
  onOpen: (_prompt: StagePromptDetail) => void;
}): React.JSX.Element {
  const { ordinal, title } = prompt;
  const testID = `journal-stage-prompt-${ordinal}`;
  if (!writable) {
    return (
      <View accessibilityLabel={`The prompt: ${title}`} testID={testID}>
        <StagePromptFace prompt={prompt} answered={answered} />
      </View>
    );
  }
  return (
    <TouchableOpacity
      onPress={() => onOpen(prompt)}
      accessibilityRole="button"
      accessibilityLabel={`${answered ? 'Write again to' : 'Write to'} the prompt: ${title}`}
      testID={testID}
    >
      <StagePromptFace prompt={prompt} answered={answered} />
    </TouchableOpacity>
  );
}

/** The declinable half of a prompt: set it aside, or bring it back.
 *
 * Sits below the prompt rather than inside its press target, so declining a
 * prompt can never be mistaken for opening it. Setting one aside is a
 * preference and not a completion — it neither marks the prompt answered nor
 * changes whether any other prompt can still be written to this week.
 */
function StagePromptChoice({
  ordinal,
  setAside,
  onSetAside,
  onBringBack,
}: {
  ordinal: number;
  setAside: boolean;
  onSetAside: (_ordinal: number) => void;
  onBringBack: (_ordinal: number) => void;
}): React.JSX.Element {
  return setAside ? (
    <ReflectionDismiss
      variant="reopen"
      label={BRING_BACK_LABEL}
      accessibilityLabel={BRING_BACK_HINT}
      testID={`journal-stage-prompt-bring-back-${ordinal}`}
      onPress={() => onBringBack(ordinal)}
    />
  ) : (
    <ReflectionDismiss
      label={SET_ASIDE_LABEL}
      accessibilityLabel={SET_ASIDE_HINT}
      testID={`journal-stage-prompt-set-aside-${ordinal}`}
      onPress={() => onSetAside(ordinal)}
    />
  );
}

/** One of the stage's prompts, with the choice of whether to keep being offered it. */
function StagePromptCard({
  prompt,
  answered,
  writable,
  onOpen,
  onSetAside,
  onBringBack,
}: {
  prompt: StagePromptDetail;
  answered: boolean;
  writable: boolean;
  onOpen: (_prompt: StagePromptDetail) => void;
  onSetAside: (_ordinal: number) => void;
  onBringBack: (_ordinal: number) => void;
}): React.JSX.Element {
  const setAside = prompt.dismissed === true;
  return (
    <View
      style={[
        styles.promptCard,
        answered ? styles.promptCardAnswered : null,
        setAside ? styles.promptCardSetAside : null,
      ]}
      testID={`journal-stage-prompt-card-${prompt.ordinal}`}
    >
      <StagePromptBody prompt={prompt} answered={answered} writable={writable} onOpen={onOpen} />
      <StagePromptChoice
        ordinal={prompt.ordinal}
        setAside={setAside}
        onSetAside={onSetAside}
        onBringBack={onBringBack}
      />
    </View>
  );
}

/**
 * The band's eyebrow row (#2949): the stage's name, upper-cased, on the left,
 * and — while some prompts are set aside and not yet shown — the count as a
 * compact control in the trailing slot. The count folds into the row its
 * label names rather than hanging under the cards as a sentence of its own.
 */
function StagePromptEyebrow({
  stageName,
  setAsideCount,
  onReveal,
}: {
  stageName: string;
  setAsideCount: number;
  onReveal: () => void;
}): React.JSX.Element {
  return (
    <View style={styles.promptSectionEyebrow} testID="journal-stage-prompts-eyebrow">
      <Text style={styles.promptSectionLabel}>{`${stageName} prompts`}</Text>
      {setAsideCount === 0 ? null : (
        <TouchableOpacity
          style={styles.promptSetAsideControl}
          onPress={onReveal}
          accessibilityRole="button"
          accessibilityLabel={SHOW_SET_ASIDE_HINT}
          testID="journal-stage-prompts-set-aside-footer"
        >
          <Text style={styles.promptSetAsideLabel}>{setAsideCountLabel(setAsideCount)}</Text>
          <ChevronRight
            color={accent.primary}
            size={SET_ASIDE_CHEVRON_SIZE}
            {...decorativeHidden()}
          />
        </TouchableOpacity>
      )}
    </View>
  );
}

/** The stage's prompts as one band, in curriculum order — the order matters,
 *  since some stages' prompts are a sequence where each feeds the next. Renders
 *  nothing at all until a stage has loaded, so the shelf never shows a
 *  placeholder standing in for a prompt the server has not named yet. */
function StagePromptSection({
  band,
  onOpen,
}: {
  band: StagePromptsBand;
  onOpen: (_prompt: StagePromptDetail) => void;
}): React.JSX.Element | null {
  const { stage, answered, writable, setAside, bringBack } = band;
  // Whether the set-aside prompts are on screen is a per-visit choice, not a
  // preference: the reader asked to see them now, and next time they arrive
  // the band is again the one they curated.
  const [revealed, setRevealed] = useState(false);
  const reveal = useCallback(() => setRevealed(true), []);
  if (stage === null || stage.prompts.length === 0) return null;
  const setAsideCount = stage.prompts.filter((prompt) => prompt.dismissed === true).length;
  const shown = revealed
    ? stage.prompts
    : stage.prompts.filter((prompt) => prompt.dismissed !== true);
  return (
    <View style={styles.promptSection} testID="journal-stage-prompts">
      <StagePromptEyebrow
        stageName={stage.stage_name}
        // Once revealed there is nothing left to offer back, so the slot empties.
        setAsideCount={revealed ? 0 : setAsideCount}
        onReveal={reveal}
      />
      {writable ? null : (
        <Text style={styles.promptSectionNote} testID="journal-stage-prompts-week-written">
          {WEEK_WRITTEN_NOTE}
        </Text>
      )}
      {shown.map((prompt) => (
        <StagePromptCard
          key={prompt.ordinal}
          prompt={prompt}
          answered={answered.has(prompt.ordinal)}
          writable={writable}
          onOpen={onOpen}
          onSetAside={setAside}
          onBringBack={bringBack}
        />
      ))}
    </View>
  );
}

export default StagePromptSection;
