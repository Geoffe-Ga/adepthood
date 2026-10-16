/**
 * The payer gate in front of a resonance pass.
 *
 * A press on "Get Resonance" used to reach ``resonance.generate`` directly, and
 * that call either uses the caller's key on the app-provider route or spends
 * a credit when the bound vault answers, even if a key is saved. This hook puts the
 * payer disclosure in between: the first
 * press (for an account that has not asked otherwise) opens
 * ``ResonanceExplainerDialog``, and only the dialog's Continue arm runs the
 * pass.
 *
 * It never calls the API itself. ``requestResonance`` comes in and goes out
 * unchanged, guarded — there is still exactly one charge path in the screen, and
 * ``useResonance``'s own in-flight latch still owns "one pass at a time".
 *
 * An exhausted wallet does not end the press on the client (#3389). Only the
 * server knows that it holds the entry as intimate, or what its care screen
 * reads, and both of those answers are free. So the press sends
 * ``requestFreeExits``, which the server never admits as a charge: a privacy
 * answer or care renders as usual, the payer refusal opens the refill remedy,
 * and a payer that could pay after all gets the price disclosed first.
 *
 * Continue is bound to the route it disclosed (#3385). The pass carries the
 * ``resonance_route`` the price was read for, and the server refuses it with
 * the same ``409 resonance_payment_unconfirmed`` when another device has since
 * connected or disconnected a vault. The gate then rereads the route and shows
 * the disclosure again, marked as changed, so nothing is charged on a payer
 * the writer was never shown -- including a writer who dismissed the note.
 *
 * A press that arrives before the stored flag has been read *waits* for it
 * rather than taking a default. The two possible defaults are not symmetric:
 * showing the note to someone who already dismissed it costs them a tap, while
 * skipping it because the read had not landed yet spends their money without
 * telling them. Waiting has neither cost, and the read is started at mount, so
 * in practice it has already settled by the time the affordance is reachable —
 * which is why the settled case is answered in the same tick as the press
 * instead of a microtask later.
 *
 * This is also why the "null while loading, render nothing" shape that
 * ``MorningPagesTip`` uses is deliberately NOT copied here. That shape exists to
 * stop a passively-rendered band from flashing on every mount; this surface is
 * not rendered until a press asks for it, so it has no flash to prevent — and
 * borrowing the shape would mean a press during the read either did nothing or
 * silently fell through to the charge.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';

import { loadCostState, UNKNOWN_COST_STATE, type ResonanceCostState } from './resonanceCost';
import { usePaymentScope } from './usePaymentScope';
import type { ResonanceRequestOutcome } from './useResonance';
import { useStoredDismissal, type StoredDismissal } from './useStoredDismissal';

import type { ResonanceRoute } from '@/api';
import { useApiKey } from '@/context/ApiKeyContext';
import { useAuth } from '@/context/AuthContext';
import { useMountedRef } from '@/hooks/useMountedRef';
import {
  loadResonanceExplainerDismissed,
  saveResonanceExplainerDismissed,
} from '@/storage/resonanceExplainerStorage';

export type ResonanceRefillReason = 'wallet_exhausted' | 'key_required';

export interface ResonanceExplainerGate {
  /** What "Get Resonance" presses: disclose first, or run the pass. */
  onPress: () => Promise<void>;
  /** The payer/dismissal preflight is coalesced and visible as button busy state. */
  pending: boolean;
  /** Leaving for payer settings invalidates a held decision from this screen. */
  cancelPending: () => void;
  /** Whether the disclosure is on screen. */
  visible: boolean;
  /** This showing follows a request refused because its payer changed (#3385). */
  payerChanged: boolean;
  /** Spend copy for the payer and deployment policy currently in force. */
  cost: string;
  keyNeeded: boolean;
  /** True while the payer is unknown or the known wallet cannot fund a pass. */
  continueDisabled: boolean;
  /** The state of the "don’t show this again" box for this showing. */
  dontShowAgain: boolean;
  onToggleDontShowAgain: () => void;
  /** Take the disclosed arm: close, persist any tick, then run the pass. */
  onContinue: () => void;
  /** Leave without a pass; a ticked box is still honoured. */
  onCancel: () => void;
  /** An exhausted account gets a remedy that dismissal can never suppress. */
  refillVisible: boolean;
  monthlyResetDate: string | null;
  monthlyCap: number | null;
  refillReason: ResonanceRefillReason;
  onCancelRefill: () => void;
  /**
   * Open the same refill remedy for a 402 that arrived somewhere other than the
   * pass — a note's first letter spends from the same wallet (#623).
   */
  showRefillFor: (_reason: ResonanceRefillReason) => Promise<void>;
}

/**
 * Resolve price copy without ever exposing the key itself.
 *
 * The defensive catches keep the disclosure truthful during a failed usage
 * read: an unknown route keeps Continue disabled rather than guessing a payer.
 */
function useResonanceCost(scopeIsCurrent: () => boolean): {
  current: ResonanceCostState;
  refresh: (_apiKey: string | null) => Promise<ResonanceCostState | null>;
} {
  const { token } = useAuth();
  const [snapshot, setSnapshot] = useState({ scopeIsCurrent, value: UNKNOWN_COST_STATE });
  const current = snapshot.scopeIsCurrent === scopeIsCurrent ? snapshot.value : UNKNOWN_COST_STATE;
  const generationRef = useRef(0);
  const mountedRef = useMountedRef();
  useEffect(
    () => () => {
      generationRef.current += 1;
    },
    [],
  );

  const refresh = useCallback(
    async (apiKey: string | null): Promise<ResonanceCostState | null> => {
      if (!scopeIsCurrent() || token === null) return null;
      const generation = ++generationRef.current;
      setSnapshot({
        scopeIsCurrent,
        value: { ...UNKNOWN_COST_STATE, canContinue: false, loading: true },
      });
      const next = await loadCostState(apiKey !== null, undefined, token);
      if (!mountedRef.current || generationRef.current !== generation || !scopeIsCurrent())
        return null;
      setSnapshot({ scopeIsCurrent, value: next });
      return next;
    },
    [mountedRef, scopeIsCurrent, token],
  );
  return useMemo(() => ({ current, refresh }), [current, refresh]);
}

/** The stored dismissal, as the gate needs to consult it. */
type DismissedFlag = StoredDismissal;

type PayerRef = MutableRefObject<{ apiKey: string | null; keyIsLoading: boolean }>;

/** Run the pass for this payer on the route its price was disclosed for (#3385). */
type RunRequest = (_apiKey: string | null, _route: ResonanceRoute | null) => Promise<void>;

/** The screen's pass, sent with the route the writer confirmed. */
type RequestResonance = (
  _apiKey: string | null,
  _route: ResonanceRoute,
) => Promise<ResonanceRequestOutcome | void>;

interface DisclosureDecisionInput {
  cost: ReturnType<typeof useResonanceCost>;
  scopeIsCurrent: () => boolean;
  disclosedKeyRef: MutableRefObject<string | null>;
  payerRef: PayerRef;
  flag: DismissedFlag;
  runRequest: RunRequest;
  /** An exhausted wallet asks the server for its free answers instead (#3389). */
  runFreeExits: () => Promise<void>;
  show: () => void;
  showRefill: (
    _monthlyResetDate: string | null,
    _monthlyCap: number | null,
    _reason: ResonanceRefillReason,
  ) => number;
}

function readyPayer(payerRef: DisclosureDecisionInput['payerRef']): string | null | undefined {
  return payerRef.current.keyIsLoading ? undefined : payerRef.current.apiKey;
}

async function publishDecision(
  payerKey: string | null,
  resolvedCost: ResonanceCostState,
  dismissed: boolean,
  input: DisclosureDecisionInput,
): Promise<void> {
  if (resolvedCost.keyNeeded) {
    input.disclosedKeyRef.current = payerKey;
    input.show();
  } else if (resolvedCost.fundingRequired === 'wallet_exhausted') {
    input.disclosedKeyRef.current = null;
    await input.runFreeExits();
  } else if (resolvedCost.fundingRequired !== null) {
    input.disclosedKeyRef.current = null;
    input.showRefill(
      resolvedCost.monthlyResetDate,
      resolvedCost.monthlyCap,
      resolvedCost.fundingRequired,
    );
  } else if (dismissed && resolvedCost.canContinue) {
    await input.runRequest(payerKey, resolvedCost.route);
  } else {
    input.disclosedKeyRef.current = payerKey;
    input.show();
  }
}

async function resolveDisclosureDecision(
  dismissed: boolean,
  input: DisclosureDecisionInput,
  isCurrent: () => boolean,
): Promise<void> {
  let payerKey = readyPayer(input.payerRef);
  // A Settings push leaves this entry mounted. If its key changes while a
  // wallet read is held, loop against the new payer before publishing a modal.
  while (payerKey !== undefined) {
    const resolvedCost = await input.cost.refresh(payerKey);
    if (resolvedCost === null || !isCurrent()) return;
    const latestPayer = readyPayer(input.payerRef);
    if (latestPayer === payerKey) {
      await publishDecision(payerKey, resolvedCost, dismissed, input);
      return;
    }
    payerKey = latestPayer;
  }
}

/** Build the one decision shared by immediate and post-hydration presses. */
function useDisclosureDecision(input: DisclosureDecisionInput) {
  const [pending, setPending] = useState(false);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useMountedRef();
  const decideOnce = useCallback(
    async (isCurrent: () => boolean): Promise<void> => {
      const known = input.flag.known();
      const dismissed = known ?? (await input.flag.read());
      if (isCurrent()) await resolveDisclosureDecision(dismissed, input, isCurrent);
    },
    [input],
  );
  const decide = useCallback(
    (_payerKey: string | null): Promise<void> => {
      if (inFlightRef.current !== null) return inFlightRef.current;
      setPending(true);
      const generation = ++generationRef.current;
      const task = decideOnce(
        () => generationRef.current === generation && input.scopeIsCurrent(),
      ).finally(() => {
        if (inFlightRef.current !== task) return;
        inFlightRef.current = null;
        if (mountedRef.current) setPending(false);
      });
      inFlightRef.current = task;
      return task;
    },
    [decideOnce, input, mountedRef],
  );
  const cancel = useCallback(() => {
    generationRef.current += 1;
    inFlightRef.current = null;
    if (mountedRef.current) setPending(false);
  }, [mountedRef]);
  return { decide, pending, cancel };
}

/** Hold a press until SecureStore has established the actual payer. */
function useHydratedPress(
  decideForKey: (_apiKey: string | null) => Promise<void>,
  apiKey: string | null,
  keyIsLoading: boolean,
): { onPress: () => Promise<void>; cancel: () => void } {
  const pendingPressRef = useRef(false);
  const onPress = useCallback(async (): Promise<void> => {
    if (keyIsLoading) {
      pendingPressRef.current = true;
      return;
    }
    await decideForKey(apiKey);
  }, [apiKey, decideForKey, keyIsLoading]);

  useEffect(() => {
    if (keyIsLoading || !pendingPressRef.current) return;
    pendingPressRef.current = false;
    void decideForKey(apiKey);
  }, [apiKey, decideForKey, keyIsLoading]);
  const cancel = useCallback(() => {
    pendingPressRef.current = false;
  }, []);
  return useMemo(() => ({ onPress, cancel }), [cancel, onPress]);
}

/**
 * Open the refill remedy for a server 402, then fill in the reset date.
 *
 * The server's 402 is already authoritative. Open the remedy immediately; a
 * follow-up read only refreshes the date and must never hold the dialog. Shared
 * by the pass and by a note's letter, which spend from the same wallet.
 */
function useShowRefillFor(
  cost: ReturnType<typeof useResonanceCost>,
  surfaces: ReturnType<typeof useDisclosureSurfaces>,
): (_reason: ResonanceRefillReason) => Promise<void> {
  return useCallback(
    async (reason: ResonanceRefillReason): Promise<void> => {
      const generation = surfaces.showRefill(
        cost.current.monthlyResetDate,
        cost.current.monthlyCap,
        reason,
      );
      if (reason === 'key_required') return;
      const latest = await cost.refresh(null);
      if (latest !== null) {
        surfaces.updateRefill(generation, latest.monthlyResetDate, latest.monthlyCap);
      }
    },
    [cost, surfaces],
  );
}

/**
 * Disclose the price that applies now, after the server declined to answer a
 * free-exits request free because a payer could pay (#3389). Never asks again
 * by itself: an account the reread still finds empty gets the refill remedy.
 */
function useRedisclose(
  cost: ReturnType<typeof useResonanceCost>,
  surfaces: ReturnType<typeof useDisclosureSurfaces>,
  payerRef: PayerRef,
  disclosedKeyRef: MutableRefObject<string | null>,
): () => Promise<void> {
  const { show, showRefill } = surfaces;
  return useCallback(async (): Promise<void> => {
    const payerKey = payerRef.current.apiKey;
    const latest = await cost.refresh(payerKey);
    if (latest === null) return;
    if (!latest.keyNeeded && latest.fundingRequired !== null) {
      showRefill(latest.monthlyResetDate, latest.monthlyCap, latest.fundingRequired);
      return;
    }
    disclosedKeyRef.current = payerKey;
    show(true);
  }, [cost, disclosedKeyRef, payerRef, show, showRefill]);
}

interface FundingAwareInput {
  requestResonance: RequestResonance;
  requestFreeExits: () => Promise<ResonanceRequestOutcome | void>;
  showRefillFor: (_reason: ResonanceRefillReason) => Promise<void>;
  redisclose: () => Promise<void>;
  scopeIsCurrent: () => boolean;
}

function useFundingAwareRequest(input: FundingAwareInput) {
  const { requestResonance, requestFreeExits, showRefillFor, redisclose, scopeIsCurrent } = input;
  const generationRef = useRef(0);
  const settle = useCallback(
    async (request: () => Promise<ResonanceRequestOutcome | void>): Promise<void> => {
      if (!scopeIsCurrent()) return;
      const requestGeneration = ++generationRef.current;
      const outcome = await request();
      if (!scopeIsCurrent() || generationRef.current !== requestGeneration) return;
      if (outcome === 'payment_unconfirmed') {
        await redisclose();
      } else if (outcome === 'funding_required' || outcome === 'key_required') {
        await showRefillFor(outcome === 'key_required' ? 'key_required' : 'wallet_exhausted');
      }
    },
    [redisclose, showRefillFor, scopeIsCurrent],
  );
  // An unknown route authorizes no charge: nothing is asked without one.
  const run = useCallback<RunRequest>(
    (payerKey, route) =>
      route === null ? Promise.resolve() : settle(() => requestResonance(payerKey, route)),
    [requestResonance, settle],
  );
  const runFreeExits = useCallback(
    (): Promise<void> => settle(requestFreeExits),
    [requestFreeExits, settle],
  );
  const cancel = useCallback(() => {
    generationRef.current += 1;
  }, []);
  return useMemo(() => ({ run, runFreeExits, cancel }), [run, runFreeExits, cancel]);
}

interface ContinueInput {
  apiKey: string | null;
  keyIsLoading: boolean;
  disclosedKeyRef: MutableRefObject<string | null>;
  cost: ReturnType<typeof useResonanceCost>;
  close: () => void;
  /** Hide the disclosure without honouring its tick: no price was accepted. */
  hide: () => void;
  runRequest: RunRequest;
  runFreeExits: () => Promise<void>;
  showRefill: (
    _monthlyResetDate: string | null,
    _monthlyCap: number | null,
    _reason: ResonanceRefillReason,
  ) => number;
}

/** Route a reread that found no payer: free answers for an empty wallet, else refill. */
function routeUnfunded(
  latest: ResonanceCostState,
  route: Pick<ContinueInput, 'hide' | 'runFreeExits' | 'showRefill'>,
): void {
  if (latest.fundingRequired === 'wallet_exhausted') {
    route.hide();
    void route.runFreeExits();
  } else if (latest.fundingRequired !== null) {
    route.showRefill(latest.monthlyResetDate, latest.monthlyCap, latest.fundingRequired);
  }
}

function useContinue(input: ContinueInput): () => void {
  const { apiKey, keyIsLoading, disclosedKeyRef, cost, close, hide, runRequest } = input;
  const { runFreeExits, showRefill } = input;
  return useCallback((): void => {
    if (keyIsLoading || apiKey !== disclosedKeyRef.current) {
      disclosedKeyRef.current = apiKey;
      void cost.refresh(apiKey).then((latest) => {
        if (latest !== null) routeUnfunded(latest, { hide, runFreeExits, showRefill });
      });
      return;
    }
    if (cost.current.loading || !cost.current.canContinue) return;
    close();
    void runRequest(disclosedKeyRef.current, cost.current.route);
  }, [
    apiKey,
    close,
    cost,
    disclosedKeyRef,
    hide,
    keyIsLoading,
    runFreeExits,
    runRequest,
    showRefill,
  ]);
}

function useRefillSurface() {
  const [refillVisible, setRefillVisible] = useState(false);
  const [monthlyResetDate, setMonthlyResetDate] = useState<string | null>(null);
  const [monthlyCap, setMonthlyCap] = useState<number | null>(null);
  const [refillReason, setRefillReason] = useState<ResonanceRefillReason>('wallet_exhausted');
  const refillGenerationRef = useRef(0);
  const refillOpenRef = useRef(false);
  const showRefill = useCallback(
    (resetDate: string | null, cap: number | null, reason: ResonanceRefillReason): number => {
      const generation = ++refillGenerationRef.current;
      refillOpenRef.current = true;
      setMonthlyResetDate(resetDate);
      setMonthlyCap(cap);
      setRefillReason(reason);
      setRefillVisible(true);
      return generation;
    },
    [],
  );
  const updateRefill = useCallback(
    (generation: number, resetDate: string | null, cap: number | null): void => {
      if (!refillOpenRef.current || refillGenerationRef.current !== generation) return;
      setMonthlyResetDate(resetDate);
      setMonthlyCap(cap);
    },
    [],
  );
  const onCancelRefill = useCallback(() => {
    refillOpenRef.current = false;
    refillGenerationRef.current += 1;
    setRefillVisible(false);
  }, []);
  return {
    refillVisible,
    monthlyResetDate,
    monthlyCap,
    refillReason,
    showRefill,
    updateRefill,
    onCancelRefill,
  };
}

function useDisclosureSurfaces(flag: DismissedFlag) {
  const [visible, setVisible] = useState(false);
  const [payerChanged, setPayerChanged] = useState(false);
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const refill = useRefillSurface();
  const { onCancelRefill, showRefill: openRefill } = refill;
  const show = useCallback(
    (changed = false) => {
      setDontShowAgain(false);
      setPayerChanged(changed);
      onCancelRefill();
      setVisible(true);
    },
    [onCancelRefill],
  );
  const showRefill = useCallback(
    (resetDate: string | null, cap: number | null, reason: ResonanceRefillReason): number => {
      setVisible(false);
      return openRefill(resetDate, cap, reason);
    },
    [openRefill],
  );
  const onToggleDontShowAgain = useCallback(() => setDontShowAgain((prev) => !prev), []);
  const close = useCallback((): void => {
    setVisible(false);
    if (dontShowAgain) flag.markDismissed();
  }, [dontShowAgain, flag]);
  const reset = useCallback(() => {
    setVisible(false);
    setDontShowAgain(false);
    onCancelRefill();
  }, [onCancelRefill]);
  return {
    ...refill,
    visible,
    payerChanged,
    dontShowAgain,
    show,
    showRefill,
    onToggleDontShowAgain,
    close,
    reset,
  };
}

function useCancelPayerWork(
  apiKey: string | null,
  cancelHydratedPress: () => void,
  cancelDecision: () => void,
  cancelFunding: () => void,
  onCancelRefill: () => void,
): () => void {
  const cancel = useCallback(() => {
    cancelHydratedPress();
    cancelDecision();
    cancelFunding();
    onCancelRefill();
  }, [cancelDecision, cancelFunding, cancelHydratedPress, onCancelRefill]);
  useEffect(() => {
    if (apiKey === null) return;
    cancelFunding();
    onCancelRefill();
  }, [apiKey, cancelFunding, onCancelRefill]);
  return cancel;
}

interface GateParts {
  decision: ReturnType<typeof useDisclosureDecision>;
  surfaces: ReturnType<typeof useDisclosureSurfaces>;
  cost: ReturnType<typeof useResonanceCost>;
  onPress: () => Promise<void>;
  onContinue: () => void;
  cancelPending: () => void;
  showRefillFor: (_reason: ResonanceRefillReason) => Promise<void>;
}

function gateFromParts(parts: GateParts): ResonanceExplainerGate {
  const { decision, surfaces, cost, onPress, onContinue, cancelPending, showRefillFor } = parts;
  return {
    onPress,
    pending: decision.pending,
    cancelPending,
    visible: surfaces.visible,
    payerChanged: surfaces.payerChanged,
    cost: cost.current.copy,
    keyNeeded: cost.current.keyNeeded,
    continueDisabled: cost.current.loading || !cost.current.canContinue,
    dontShowAgain: surfaces.dontShowAgain,
    onToggleDontShowAgain: surfaces.onToggleDontShowAgain,
    onContinue,
    onCancel: surfaces.close,
    refillVisible: surfaces.refillVisible,
    monthlyResetDate: surfaces.monthlyResetDate,
    monthlyCap: surfaces.monthlyCap,
    refillReason: surfaces.refillReason,
    onCancelRefill: surfaces.onCancelRefill,
    showRefillFor,
  };
}

/** Clear prior-owner surfaces while immediately hiding them on the transition render. */
function useScopeSurfaces(
  scopeIsCurrent: () => boolean,
  cancelPending: () => void,
  surfaces: ReturnType<typeof useDisclosureSurfaces>,
): boolean {
  const surfaceScopeRef = useRef(scopeIsCurrent);
  const sameScope = surfaceScopeRef.current === scopeIsCurrent;
  useEffect(() => {
    if (surfaceScopeRef.current === scopeIsCurrent) return;
    surfaceScopeRef.current = scopeIsCurrent;
    cancelPending();
    surfaces.reset();
  }, [scopeIsCurrent, cancelPending, surfaces]);
  return sameScope;
}

function usePayerRef(apiKey: string | null, keyIsLoading: boolean) {
  const payerRef = useRef({ apiKey, keyIsLoading });
  payerRef.current = { apiKey, keyIsLoading };
  return payerRef;
}

/** Resolve the current payer, disclosure preference, and one funding decision together. */
function usePayerParts(
  requestResonance: RequestResonance,
  requestFreeExits: () => Promise<ResonanceRequestOutcome | void>,
  scopeIsCurrent: () => boolean,
) {
  const { apiKey, isLoading: keyIsLoading } = useApiKey();
  const payerRef = usePayerRef(apiKey, keyIsLoading);
  const flag = useStoredDismissal(
    loadResonanceExplainerDismissed,
    saveResonanceExplainerDismissed,
    scopeIsCurrent,
  );
  const surfaces = useDisclosureSurfaces(flag);
  const cost = useResonanceCost(scopeIsCurrent);
  const disclosedKeyRef = useRef<string | null>(null);
  const showRefillFor = useShowRefillFor(cost, surfaces);
  const redisclose = useRedisclose(cost, surfaces, payerRef, disclosedKeyRef);
  const funding = useFundingAwareRequest({
    requestResonance,
    requestFreeExits,
    showRefillFor,
    redisclose,
    scopeIsCurrent,
  });
  const decision = useDisclosureDecision({
    cost,
    scopeIsCurrent,
    disclosedKeyRef,
    payerRef,
    flag,
    runRequest: funding.run,
    runFreeExits: funding.runFreeExits,
    show: surfaces.show,
    showRefill: surfaces.showRefill,
  });
  return {
    apiKey,
    keyIsLoading,
    surfaces,
    cost,
    disclosedKeyRef,
    showRefillFor,
    funding,
    decision,
  };
}

/** Gate ``requestResonance`` behind disclosure pinned to the accepted payer. */
export function useResonanceExplainer(
  requestResonance: RequestResonance,
  requestFreeExits: () => Promise<ResonanceRequestOutcome | void>,
): ResonanceExplainerGate {
  const scopeIsCurrent = usePaymentScope();
  const {
    apiKey,
    keyIsLoading,
    surfaces,
    cost,
    disclosedKeyRef,
    showRefillFor,
    funding,
    decision,
  } = usePayerParts(requestResonance, requestFreeExits, scopeIsCurrent);
  const hydratedPress = useHydratedPress(decision.decide, apiKey, keyIsLoading);
  const onContinue = useContinue({
    apiKey,
    keyIsLoading,
    disclosedKeyRef,
    cost,
    close: surfaces.close,
    hide: surfaces.reset,
    runRequest: funding.run,
    runFreeExits: funding.runFreeExits,
    showRefill: surfaces.showRefill,
  });
  const cancelPending = useCancelPayerWork(
    apiKey,
    hydratedPress.cancel,
    decision.cancel,
    funding.cancel,
    surfaces.onCancelRefill,
  );

  const sameScope = useScopeSurfaces(scopeIsCurrent, cancelPending, surfaces);
  const gate = gateFromParts({
    decision,
    surfaces,
    cost,
    onPress: hydratedPress.onPress,
    onContinue,
    cancelPending,
    showRefillFor,
  });
  return {
    ...gate,
    visible: sameScope && gate.visible,
    refillVisible: sameScope && gate.refillVisible,
  };
}
