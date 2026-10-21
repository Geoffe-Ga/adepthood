/**
 * ``ResonanceEssayModal`` — a margin note expanded into its letter-like essay,
 * hovering over the (still-visible, dimmed) page. A warm editorial reading card,
 * not a chat reply.
 *
 * A first letter uses the writer's key on the app-provider route or one wallet
 * credit when their vault writes it. So a note
 * with no letter opens on an *offer* — what a letter is, where the entry goes,
 * what it costs, and two equal arms — and only "Ask for the letter" asks. A
 * letter already written opens straight to the letter, because reopening it is
 * free. A 402 is not rendered as an error: it is handed to ``onFundingRequired``
 * so the screen can show the same refill remedy a resonance pass gets.
 *
 * A vault-bound writer's ask can be answered by the vault's care guard instead
 * of a letter (#3380). The server then sends its own reviewed care surface, and
 * the card shows exactly that -- the same ``CareSupportNote`` a resonance pass
 * shows -- rather than a blank-letter error and a nudge to ask again.
 *
 * The ask carries the payer route its price was disclosed for (#3385). When
 * another device has connected or disconnected a vault since, the server
 * refuses it with ``409 essay_price_unacknowledged`` before anything is
 * charged, and the card returns to the offer with the price that applies now.
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

import { aiAccessRevoked } from './aiAccessRevoked';
import CareSupportNote from './CareSupportNote';
import { ExplainerActionPair, PayerChangedNotice, explainerStyles } from './ExplainerDialogParts';
import { fundingOutcome, type FundingOutcome } from './fundingOutcome';
import { generationRefusal } from './generationRefusal';
import JournalModalShell from './JournalModalShell';
import { loadCostState, unknownCostState, type ResonanceCostState } from './resonanceCost';
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
import { usePaymentScope } from './usePaymentScope';
import type { VaultKeyVendor } from './vaultKeyCopy';

import { resonance } from '@/api';
import type { CareResponse, EssayResponse, Marginalia, ResonanceRoute } from '@/api';
import { formatApiError } from '@/api/errorMessages';
import { useAuth } from '@/context/AuthContext';
import { colors, editorialType, spacing, touchTarget } from '@/design/tokens';

export interface ResonanceEssayModalProps {
  note: Marginalia | null;
  onClose: () => void;
  /** Close the offer and open the device's API key settings. */
  onOpenSettings?: () => void;
  onEssayLoaded?: (_note: Marginalia) => void;
  /** Whether an own key is available; the server route also gates eligibility. */
  hasOwnKey?: boolean;
  /** The vendor of that key, so a managed vault that writes with it can say so (#3437). */
  ownKeyVendor?: VaultKeyVendor | null;
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
  /** The offer is back because the ask's payer route changed (#3385). */
  payerChanged?: boolean;
  /** The vault's care guard answered instead of a letter: the server's care surface (#3380). */
  care?: CareResponse;
}

const OFFER_STATE: EssayState = { essay: null, loading: false, error: null, offer: true };
const PAYER_CHANGED_STATE: EssayState = { ...OFFER_STATE, payerChanged: true };
const LOADING_STATE: EssayState = { essay: null, loading: true, error: null, offer: false };

/** The 409 an ask gets when the price it acknowledged is not the one in force (#3385). */
const PRICE_UNACKNOWLEDGED_DETAIL = 'essay_price_unacknowledged';

function priceUnacknowledged(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const response = error as { status?: unknown; detail?: unknown };
  return response.status === 409 && response.detail === PRICE_UNACKNOWLEDGED_DETAIL;
}

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

/**
 * What an ask that produced no letter said: a refusal and whether asking again
 * could help, or the server's care surface when the vault's care guard answered.
 */
type Unanswered =
  { kind: 'refused'; message: string; retryable: boolean } | { kind: 'care'; care: CareResponse };

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
  return remembered === undefined ? OFFER_STATE : unansweredState(remembered);
}

/** The three ways an ask settles, handed to {@link askForEssay} by the hook. */
interface EssaySettlers {
  /** A real letter arrived, and should be cached back onto the note. */
  onLetter: (_updated: Marginalia) => void;
  /** The ask produced no letter: a refusal, an intimate entry, a failure, or care. */
  onUnanswered: (_unanswered: Unanswered) => void;
  /** The ask was refused for want of a payer; nothing was spent. */
  onFunding: (_outcome: FundingOutcome) => void;
  /** The payer route changed since the price was shown; nothing was spent. */
  onPayerChanged: () => void;
}

/** Ask for one note's letter on the disclosed route, price acknowledged, and route the outcome. */
function askForEssay(noteId: number, route: ResonanceRoute, settlers: EssaySettlers): void {
  resonance
    .essay(noteId, { priceAcknowledged: true, disclosedRoute: route })
    .then((updated: EssayResponse) => {
      if (updated.essay) {
        settlers.onLetter(updated);
        return;
      }
      if (updated.care != null) {
        settlers.onUnanswered({ kind: 'care', care: updated.care });
        return;
      }
      settlers.onUnanswered({ kind: 'refused', message: BLANK_ESSAY_MESSAGE, retryable: true });
    })
    .catch((err: unknown) => {
      if (priceUnacknowledged(err)) {
        settlers.onPayerChanged();
        return;
      }
      const funding = fundingOutcome(err);
      if (funding !== null) {
        settlers.onFunding(funding);
        return;
      }
      settlers.onUnanswered({
        kind: 'refused',
        message: formatApiError(err),
        // Neither midnight's ceiling nor a revoked entitlement (#1938) clears on retry.
        retryable: generationRefusal(err) !== 'daily_limit' && !aiAccessRevoked(err),
      });
    });
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

/** The card showing a letter that just arrived. */
function letterState(updated: Marginalia): EssayState {
  return {
    ...LOADING_STATE,
    essay: updated.essay,
    loading: false,
    essaySource: updated.essay_source,
  };
}

/** The card after an ask that produced no letter: the refusal, or the server's care. */
function unansweredState(unanswered: Unanswered): EssayState {
  if (unanswered.kind === 'care') {
    return { essay: null, loading: false, error: null, offer: false, care: unanswered.care };
  }
  return {
    essay: null,
    loading: false,
    error: unanswered.message,
    retryable: unanswered.retryable,
    offer: false,
  };
}

/**
 * Let go of an ask whose payer lineage ended under it (#3387).
 *
 * A token renewal keeps the lineage, so a letter asked across one still lands.
 * A sign-out, an account switch or the same account signing back in after a
 * 401 ends it, and that ask's answer is refused. Re-derived during render, so
 * the card returns to its offer instead of spinning forever; asking again is
 * safe because the server answers an already-written letter from its cache
 * without a second charge.
 */
function useLineageRelease(
  scopeIsCurrent: () => boolean,
  loading: boolean,
  setState: React.Dispatch<React.SetStateAction<EssayState>>,
): void {
  const [lineage, setLineage] = useState(() => scopeIsCurrent);
  if (lineage !== scopeIsCurrent) {
    setLineage(() => scopeIsCurrent);
    if (loading) setState(OFFER_STATE);
  }
}

/** The note's letter: shown, offered at its price, or asked for on purpose. */
function useEssay(
  note: Marginalia | null,
  callbacks: EssayCallbacks,
  scopeIsCurrent: () => boolean,
): EssayState & { ask: (_route: ResonanceRoute) => void; retry: () => void; costRevision: number } {
  // Notes already asked about, that came back with no letter (#2435). A ref, so
  // it survives closing and reopening the modal and dies with the screen:
  // reopening shows that outcome rather than the offer again, while ``retry``
  // forgets it and returns the writer to the offer — never to an automatic ask.
  const unansweredRef = useRef<UnansweredNotes>(new Map());
  const [state, setState] = useShownState(note, unansweredRef.current);
  const showingRef = useShowingGeneration(note);
  useLineageRelease(scopeIsCurrent, state.loading, setState);
  const callbacksRef = useLatest(callbacks);
  // Bumped when the payer changed under an ask, so the offer rereads its price.
  const [costRevision, setCostRevision] = useState(0);

  const ask = useCallback(
    (route: ResonanceRoute) => {
      if (note == null) return;
      const showing = showingRef.current;
      const isCurrent = (): boolean => showingRef.current === showing && scopeIsCurrent();
      setState(LOADING_STATE);
      askForEssay(note.id, route, {
        onLetter: (updated) => {
          if (!isCurrent()) return;
          // The note carries the letter from here on, via ``onEssayLoaded``.
          setState(letterState(updated));
          callbacksRef.current.onEssayLoaded?.(updated);
        },
        // Remembered even if the modal has since closed: the ask did happen and
        // produced nothing, so reopening should show that, not offer again.
        onUnanswered: (unanswered) => {
          if (!scopeIsCurrent()) return;
          unansweredRef.current.set(note.id, unanswered);
          if (isCurrent()) setState(unansweredState(unanswered));
        },
        onFunding: (outcome) => {
          if (!isCurrent()) return;
          setState(OFFER_STATE);
          callbacksRef.current.onFundingRequired?.(outcome);
        },
        // Back to the offer, which rereads the route and shows its price.
        onPayerChanged: () => {
          if (!isCurrent()) return;
          setState(PAYER_CHANGED_STATE);
          setCostRevision((n) => n + 1);
        },
      });
    },
    [callbacksRef, note, setState, showingRef, scopeIsCurrent],
  );

  const retry = useCallback(() => {
    if (note != null) unansweredRef.current.delete(note.id);
    setState(OFFER_STATE);
  }, [note, setState]);

  return { ...state, ask, retry, costRevision };
}

/** The priced offer: what a letter is, what it costs, and two equal arms. */
function EssayOffer({
  cost,
  payerChanged = false,
  onOpenSettings,
  onAsk,
  onDecline,
}: {
  cost: ResonanceCostState;
  payerChanged?: boolean;
  onOpenSettings: () => void;
  onAsk: () => void;
  onDecline: () => void;
}): React.JSX.Element {
  return (
    <View testID="essay-offer">
      <Text style={explainerStyles.body} testID="essay-ask-what">
        {ESSAY_ASK_WHAT}
      </Text>
      <PayerChangedNotice visible={payerChanged} testID="essay-payer-changed" />
      <Text style={explainerStyles.body} testID="essay-ask-cost">
        {cost.copy}
      </Text>
      <Text style={explainerStyles.body} testID="essay-ask-choice">
        {ESSAY_ASK_CHOICE}
      </Text>
      <EssayActions {...{ cost, onOpenSettings, onAsk, onDecline }} />
    </View>
  );
}

/** The only offered action must be eligible on the recorded route. */
function EssayActions({
  cost,
  onOpenSettings,
  onAsk,
  onDecline,
}: {
  cost: ResonanceCostState;
  onOpenSettings: () => void;
  onAsk: () => void;
  onDecline: () => void;
}): React.JSX.Element {
  return (
    <View>
      {cost.canContinue || cost.fundingRequired === 'key_required' ? (
        <ExplainerActionPair
          cancel={{
            label: ESSAY_ASK_CANCEL,
            accessibilityLabel: ESSAY_ASK_CANCEL_A11Y,
            testID: 'essay-not-now',
            onPress: onDecline,
          }}
          proceed={{
            label: cost.canContinue ? ESSAY_ASK_PROCEED : 'Open Settings',
            accessibilityLabel: cost.canContinue
              ? ESSAY_ASK_PROCEED_A11Y
              : 'Open Settings to add your own API key',
            testID: cost.canContinue ? 'essay-ask' : 'essay-open-settings',
            onPress: cost.canContinue ? onAsk : onOpenSettings,
          }}
        />
      ) : (
        <TouchableOpacity
          style={explainerStyles.action}
          onPress={onDecline}
          accessibilityRole="button"
          accessibilityLabel={ESSAY_ASK_CANCEL_A11Y}
          testID="essay-not-now"
        >
          <Text style={explainerStyles.cancelLabel}>{ESSAY_ASK_CANCEL}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

/** The body region: spinner, the essay, the server's care, or a friendly error with retry. */
function EssayBody({
  essay,
  loading,
  error,
  retryable = true,
  retry,
  essaySource,
  care,
}: Omit<EssayState, 'offer'> & { retry: () => void }) {
  if (loading) {
    return <ActivityIndicator testID="essay-loading" color={colors.paper.ink} />;
  }
  if (care !== undefined) {
    // The vault's care guard answered instead of a letter (#3380): only the
    // server's reviewed copy, and no nudge to ask for the letter again.
    return <CareSupportNote care={care} flush />;
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

/**
 * Resolve only an uncached offer; responses belong to one note/key showing.
 * A new ``revision`` rereads the route for the same showing (#3385).
 */
interface OwnKey {
  hasOwnKey: boolean;
  /** The key's vendor, so a managed vault that writes with it can say so (#3437). */
  ownKeyVendor: VaultKeyVendor | null;
}

function useEssayCost(
  note: Marginalia | null,
  { hasOwnKey, ownKeyVendor }: OwnKey,
  scopeIsCurrent: () => boolean,
  revision: number,
): ResonanceCostState {
  // Read at dispatch: a renewal keeps the lineage (#3387), so it must not reread the price.
  const { token } = useAuth();
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const [snapshot, setSnapshot] = useState({ note, hasOwnKey, scopeIsCurrent, revision });
  const [cost, setCost] = useState(() => unknownCostState(ESSAY_NOUN));
  if (
    snapshot.note !== note ||
    snapshot.hasOwnKey !== hasOwnKey ||
    snapshot.scopeIsCurrent !== scopeIsCurrent ||
    snapshot.revision !== revision
  ) {
    setSnapshot({ note, hasOwnKey, scopeIsCurrent, revision });
    setCost(unknownCostState(ESSAY_NOUN));
  }
  useEffect(() => {
    const token = tokenRef.current;
    if (note === null || token === null || !scopeIsCurrent()) return;
    let current = true;
    setCost({
      ...unknownCostState(ESSAY_NOUN),
      copy: 'Checking whether a letter can be written…',
      loading: true,
    });
    void loadCostState(hasOwnKey, ESSAY_NOUN, token, ownKeyVendor).then((next) => {
      if (current && scopeIsCurrent()) setCost(next);
    });
    return () => {
      current = false;
    };
  }, [note, hasOwnKey, ownKeyVendor, scopeIsCurrent, revision]);
  return cost;
}

/** The note identity and reachable close action above the scrollable letter. */
function EssayHeader({ note, onClose }: { note: Marginalia | null; onClose: () => void }) {
  return (
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
  );
}

function ResonanceEssayModal({
  note,
  onClose,
  onEssayLoaded,
  onOpenSettings = () => undefined,
  hasOwnKey = false,
  ownKeyVendor = null,
  onFundingRequired,
}: ResonanceEssayModalProps): React.JSX.Element {
  const scopeIsCurrent = usePaymentScope();
  const shown = useEssay(note, { onEssayLoaded, onFundingRequired }, scopeIsCurrent);
  const offer = shown.offer ? note : null;
  const cost = useEssayCost(offer, { hasOwnKey, ownKeyVendor }, scopeIsCurrent, shown.costRevision);

  return (
    <JournalModalShell
      visible={note != null}
      onDismiss={onClose}
      scrimTestID="essay-scrim"
      scrimLabel="Dismiss essay"
      modalTestID="essay-modal"
      cardStyle={styles.essayCard}
    >
      <EssayHeader note={note} onClose={onClose} />
      <Text style={styles.quote} testID="essay-quote">
        “{note?.anchor_text}”
      </Text>
      <ScrollView contentContainerStyle={styles.bodyScroll}>
        {shown.offer ? (
          <EssayOffer
            cost={cost}
            payerChanged={shown.payerChanged}
            onOpenSettings={onOpenSettings}
            onAsk={() => {
              if (scopeIsCurrent() && cost.canContinue && cost.route !== null) {
                shown.ask(cost.route);
              }
            }}
            onDecline={onClose}
          />
        ) : (
          <EssayBody {...shown} />
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
