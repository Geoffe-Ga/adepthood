/**
 * ``ResonanceEssayModal`` — a margin note expanded into its letter-like essay,
 * hovering over the (still-visible, dimmed) page. A warm editorial reading card,
 * not a chat reply.
 *
 * A note's first letter is a charged depth (#623): the server spends one unit of
 * the BotMason wallet to write it unless the writer's own key pays. So a note
 * with no letter opens on an *offer* — what a letter is, where the entry goes,
 * what it costs, and two equal arms — and only "Ask for the letter" asks. A
 * letter already written opens straight to the letter, because reopening it is
 * free. A 402 is not rendered as an error: it is handed to ``onFundingRequired``
 * so the screen can show the same refill remedy a resonance pass gets.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

import { ExplainerActionPair, explainerStyles } from './ExplainerDialogParts';
import { fundingOutcome, type FundingOutcome } from './fundingOutcome';
import { generationRefusal } from './generationRefusal';
import JournalModalShell from './JournalModalShell';
import { loadCostState, unknownCostState } from './resonanceCost';
import {
  ESSAY_ASK_CANCEL,
  ESSAY_ASK_CANCEL_A11Y,
  ESSAY_ASK_CHOICE,
  ESSAY_ASK_PROCEED,
  ESSAY_ASK_PROCEED_A11Y,
  ESSAY_ASK_WHAT,
  ESSAY_NOUN,
} from './resonanceExplainerCopy';
import { sourceLabel } from './sourceLabel';

import { resonance } from '@/api';
import type { Marginalia } from '@/api';
import { formatApiError } from '@/api/errorMessages';
import { colors, editorialType, spacing, touchTarget } from '@/design/tokens';

export interface ResonanceEssayModalProps {
  note: Marginalia | null;
  onClose: () => void;
  onEssayLoaded?: (_note: Marginalia) => void;
  /** Whether the writer's own API key pays, which decides the price line. */
  hasOwnKey?: boolean;
  /** A 402 on the ask: the wallet is empty, or a key is required. */
  onFundingRequired?: (_outcome: FundingOutcome) => void;
}

/** Shown when a fetch resolves an empty essay, so the user isn't stranded on a blank card. */
const BLANK_ESSAY_MESSAGE = "This note's essay isn't ready yet.";

interface EssayState {
  essay: string | null;
  loading: boolean;
  error: string | null;
  /**
   * Whether ``error`` offers "Tap to try again". False only for the daily
   * generation ceiling (#623), which cannot clear before midnight UTC.
   */
  retryable?: boolean;
  /** The note has no letter yet: show its price and wait for the writer to ask. */
  offer: boolean;
  /** Which side wrote the letter, as the server recorded it (#3062). */
  essaySource?: unknown;
}

const OFFER_STATE: EssayState = { essay: null, loading: false, error: null, offer: true };
const LOADING_STATE: EssayState = { essay: null, loading: true, error: null, offer: false };

/**
 * Why an ask for a note's letter settled without one, keyed by note id.
 *
 * The server deliberately leaves ``essay`` NULL when it refuses a completion as
 * not-a-letter, and when the entry is intimate, so the writer can ask again
 * (``backend/src/routers/journal.py::_cache_essay``). That is precisely why the
 * note itself cannot record "already asked" — so the fact is remembered here
 * instead, and only for as long as this screen is mounted.
 */
type UnansweredNotes = Map<number, Unanswered>;

/** What an ask that produced no letter said, and whether asking again could help. */
interface Unanswered {
  message: string;
  retryable: boolean;
}

/**
 * The state a note is shown from: its own cached letter, else a remembered ask
 * that produced none, else the priced offer. A blank cached essay counts as
 * missing, so an empty body is never rendered.
 */
function initialState(note: Marginalia, unanswered: UnansweredNotes): EssayState {
  if (note.essay) {
    return {
      essay: note.essay,
      loading: false,
      error: null,
      offer: false,
      essaySource: note.essay_source,
    };
  }
  const remembered = unanswered.get(note.id);
  if (remembered !== undefined) {
    return {
      essay: null,
      loading: false,
      error: remembered.message,
      retryable: remembered.retryable,
      offer: false,
    };
  }
  return OFFER_STATE;
}

/** The three ways an ask settles, handed to {@link askForEssay} by the hook. */
interface EssaySettlers {
  /** A real letter arrived, and should be cached back onto the note. */
  onLetter: (_updated: Marginalia) => void;
  /** The ask produced no letter: a refusal, an intimate entry, or a failure. */
  onUnanswered: (_unanswered: Unanswered) => void;
  /** The ask was refused for want of a payer; nothing was spent. */
  onFunding: (_outcome: FundingOutcome) => void;
}

/** Ask the server for one note's letter, price acknowledged, and route the outcome. */
function askForEssay(noteId: number, settlers: EssaySettlers): void {
  resonance
    .essay(noteId, { priceAcknowledged: true })
    .then((updated) => {
      if (updated.essay) {
        settlers.onLetter(updated);
        return;
      }
      settlers.onUnanswered({ message: BLANK_ESSAY_MESSAGE, retryable: true });
    })
    .catch((err: unknown) => {
      const funding = fundingOutcome(err);
      if (funding !== null) {
        settlers.onFunding(funding);
        return;
      }
      settlers.onUnanswered({
        message: formatApiError(err),
        retryable: generationRefusal(err) !== 'daily_limit',
      });
    });
}

/** The letter's price line, read only while the offer is on screen. */
function useEssayCost(showing: boolean, hasOwnKey: boolean): string {
  const [copy, setCopy] = useState(() => unknownCostState(ESSAY_NOUN).copy);
  useEffect(() => {
    if (!showing) return undefined;
    let active = true;
    void loadCostState(hasOwnKey, ESSAY_NOUN).then((next) => {
      if (active) setCopy(next.copy);
    });
    return () => {
      active = false;
    };
  }, [showing, hasOwnKey]);
  return copy;
}

interface EssayCallbacks {
  onEssayLoaded?: (_n: Marginalia) => void;
  onFundingRequired?: (_outcome: FundingOutcome) => void;
}

/** Hold the latest callbacks so a non-memoised caller can't retrigger anything. */
function useLatest<T>(value: T): React.MutableRefObject<T> {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

/**
 * What the modal shows for ``note``, re-derived *during render* when the note
 * changes rather than an effect later: an effect would paint one frame of the
 * previous state first, so a cached letter could flash the offer and read the
 * wallet for a price it will never charge. React's documented "adjust state
 * when a prop changes" pattern.
 */
function useShownState(
  note: Marginalia | null,
  unanswered: UnansweredNotes,
): [EssayState, React.Dispatch<React.SetStateAction<EssayState>>] {
  const [state, setState] = useState<EssayState>(() =>
    note == null ? OFFER_STATE : initialState(note, unanswered),
  );
  const [shownFor, setShownFor] = useState<Marginalia | null>(note);
  if (shownFor !== note) {
    setShownFor(note);
    setState(note == null ? OFFER_STATE : initialState(note, unanswered));
  }
  return [state, setState];
}

/**
 * A counter bumped whenever the modal's note changes or it unmounts, so an
 * answer that lands afterwards is not applied to a card the writer has left.
 */
function useShowingGeneration(note: Marginalia | null): React.MutableRefObject<number> {
  const showingRef = useRef(0);
  useEffect(() => {
    showingRef.current += 1;
  }, [note]);
  useEffect(
    () => () => {
      showingRef.current += 1;
    },
    [],
  );
  return showingRef;
}

/** The note's letter: shown, offered at its price, or asked for on purpose. */
function useEssay(
  note: Marginalia | null,
  callbacks: EssayCallbacks,
): EssayState & { ask: () => void; retry: () => void } {
  // Notes already asked about, that came back with no letter (#2435). A ref, so
  // it survives closing and reopening the modal and dies with the screen:
  // reopening shows that outcome rather than the offer again, while ``retry``
  // forgets it and returns the writer to the offer — never to an automatic ask.
  const unansweredRef = useRef<UnansweredNotes>(new Map());
  const [state, setState] = useShownState(note, unansweredRef.current);
  const showingRef = useShowingGeneration(note);
  const callbacksRef = useLatest(callbacks);

  const ask = useCallback(() => {
    if (note == null) return;
    const showing = showingRef.current;
    const isCurrent = (): boolean => showingRef.current === showing;
    setState(LOADING_STATE);
    askForEssay(note.id, {
      onLetter: (updated) => {
        if (!isCurrent()) return;
        // The note carries the letter from here on, via ``onEssayLoaded``.
        setState({
          essay: updated.essay,
          loading: false,
          error: null,
          offer: false,
          essaySource: updated.essay_source,
        });
        callbacksRef.current.onEssayLoaded?.(updated);
      },
      // Remembered even if the modal has since closed: the ask did happen and
      // produced nothing, so reopening should show that, not offer again.
      onUnanswered: (unanswered) => {
        unansweredRef.current.set(note.id, unanswered);
        if (!isCurrent()) return;
        setState({
          essay: null,
          loading: false,
          error: unanswered.message,
          retryable: unanswered.retryable,
          offer: false,
        });
      },
      onFunding: (outcome) => {
        if (!isCurrent()) return;
        setState(OFFER_STATE);
        callbacksRef.current.onFundingRequired?.(outcome);
      },
    });
  }, [callbacksRef, note, setState, showingRef]);

  const retry = useCallback(() => {
    if (note != null) unansweredRef.current.delete(note.id);
    setState(OFFER_STATE);
  }, [note, setState]);

  return { ...state, ask, retry };
}

/** The priced offer: what a letter is, what it costs, and two equal arms. */
function EssayOffer({
  cost,
  onAsk,
  onDecline,
}: {
  cost: string;
  onAsk: () => void;
  onDecline: () => void;
}): React.JSX.Element {
  return (
    <View testID="essay-offer">
      <Text style={explainerStyles.body} testID="essay-ask-what">
        {ESSAY_ASK_WHAT}
      </Text>
      <Text style={explainerStyles.body} testID="essay-ask-cost">
        {cost}
      </Text>
      <Text style={explainerStyles.body} testID="essay-ask-choice">
        {ESSAY_ASK_CHOICE}
      </Text>
      <ExplainerActionPair
        cancel={{
          label: ESSAY_ASK_CANCEL,
          accessibilityLabel: ESSAY_ASK_CANCEL_A11Y,
          testID: 'essay-not-now',
          onPress: onDecline,
        }}
        proceed={{
          label: ESSAY_ASK_PROCEED,
          accessibilityLabel: ESSAY_ASK_PROCEED_A11Y,
          testID: 'essay-ask',
          onPress: onAsk,
        }}
      />
    </View>
  );
}

/** The body region: spinner, the essay, or a friendly error with retry. */
function EssayBody({
  essay,
  loading,
  error,
  retryable = true,
  retry,
  essaySource,
}: Omit<EssayState, 'offer'> & { retry: () => void }) {
  if (loading) {
    return <ActivityIndicator testID="essay-loading" color={colors.paper.ink} />;
  }
  if (error != null) {
    // Announced as it appears, like the margin's own error line: a writer on a
    // screen reader would otherwise hear nothing after asking.
    return (
      <View>
        <Text
          style={styles.error}
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          testID="essay-error"
        >
          {error}
        </Text>
        {retryable ? (
          <TouchableOpacity onPress={retry} accessibilityRole="button" testID="essay-retry">
            <Text style={styles.retry}>Tap to try again</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    );
  }
  return (
    <View>
      <Text style={styles.essay} testID="essay-text">
        {essay}
      </Text>
      <Text style={styles.source} testID="essay-source">
        {sourceLabel(essaySource)}
      </Text>
    </View>
  );
}

function ResonanceEssayModal({
  note,
  onClose,
  onEssayLoaded,
  hasOwnKey = false,
  onFundingRequired,
}: ResonanceEssayModalProps): React.JSX.Element {
  const { essay, loading, error, retryable, offer, essaySource, ask, retry } = useEssay(note, {
    onEssayLoaded,
    onFundingRequired,
  });
  const cost = useEssayCost(note != null && offer, hasOwnKey);

  return (
    <JournalModalShell
      visible={note != null}
      onDismiss={onClose}
      scrimTestID="essay-scrim"
      scrimLabel="Dismiss essay"
      modalTestID="essay-modal"
      cardStyle={styles.essayCard}
    >
      <View style={styles.header}>
        <Text style={[styles.kind, { color: note ? colors.marginalia[note.kind] : undefined }]}>
          {note?.kind}
        </Text>
        <TouchableOpacity
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
          testID="essay-close"
        >
          <Text style={styles.close}>×</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.quote} testID="essay-quote">
        “{note?.anchor_text}”
      </Text>
      <ScrollView contentContainerStyle={styles.bodyScroll}>
        {offer ? (
          <EssayOffer cost={cost} onAsk={ask} onDecline={onClose} />
        ) : (
          <EssayBody {...{ essay, loading, error, retryable, retry, essaySource }} />
        )}
      </ScrollView>
    </JournalModalShell>
  );
}

const styles = StyleSheet.create({
  essayCard: {
    maxHeight: '80%',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  kind: {
    ...editorialType.caption,
    textTransform: 'capitalize',
    fontWeight: '600',
  },
  close: {
    fontSize: 28,
    lineHeight: 28,
    minWidth: touchTarget.minimum,
    textAlign: 'right',
    color: colors.paper.inkSoft,
  },
  quote: {
    ...editorialType.title,
    color: colors.paper.ink,
    paddingVertical: spacing(1.5),
  },
  bodyScroll: {
    paddingTop: spacing(1),
  },
  essay: {
    ...editorialType.body,
    color: colors.paper.ink,
  },
  source: {
    ...editorialType.caption,
    color: colors.paper.inkSoft,
    paddingTop: spacing(1),
  },
  error: {
    ...editorialType.body,
    color: colors.danger,
  },
  retry: {
    ...editorialType.action,
    color: colors.paper.inkSoft,
    paddingTop: spacing(1),
  },
});

export default ResonanceEssayModal;
