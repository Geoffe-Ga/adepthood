/**
 * The payer gate in front of a resonance pass.
 *
 * A press on "Get Resonance" used to reach ``resonance.generate`` directly, and
 * that call either uses the caller's API key or deducts one message from the
 * account's BotMason allowance before it dials the model. This hook puts the
 * payer disclosure in between: the first
 * press (for an account that has not asked otherwise) opens
 * ``ResonanceExplainerDialog``, and only the dialog's Continue arm runs the
 * pass.
 *
 * It never calls the API itself. ``requestResonance`` comes in and goes out
 * unchanged, guarded — there is still exactly one charge path in the screen, and
 * ``useResonance``'s own in-flight latch still owns "one pass at a time".
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

import { resonanceExplainerCanContinue, resonanceExplainerCost } from './resonanceExplainerCopy';
import type { ResonanceRequestOutcome } from './useResonance';

import { botmasonUsage } from '@/api';
import { useApiKey } from '@/context/ApiKeyContext';
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
  /** Spend copy for the payer and deployment policy currently in force. */
  cost: string;
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
}

const UNKNOWN_COST = resonanceExplainerCost(false, null);

interface ResonanceCostState {
  copy: string;
  canContinue: boolean;
  loading: boolean;
  monthlyResetDate: string | null;
  monthlyCap: number | null;
}

const UNKNOWN_COST_STATE: ResonanceCostState = {
  copy: UNKNOWN_COST,
  canContinue: true,
  loading: false,
  monthlyResetDate: null,
  monthlyCap: null,
};

type Usage = Awaited<ReturnType<typeof botmasonUsage.get>>;

function costStateFromUsage(usage: Usage): ResonanceCostState {
  return {
    copy: resonanceExplainerCost(
      false,
      usage.monthly_cap,
      usage.monthly_messages_remaining,
      usage.offering_balance,
    ),
    canContinue: resonanceExplainerCanContinue(
      false,
      usage.monthly_messages_remaining,
      usage.offering_balance,
    ),
    loading: false,
    monthlyResetDate: usage.monthly_reset_date,
    monthlyCap: usage.monthly_cap,
  };
}

async function loadCostState(apiKey: string | null): Promise<ResonanceCostState> {
  if (apiKey !== null) {
    return {
      copy: resonanceExplainerCost(true, null),
      canContinue: true,
      loading: false,
      monthlyResetDate: null,
      monthlyCap: null,
    };
  }
  try {
    return costStateFromUsage(await botmasonUsage.get());
  } catch {
    return UNKNOWN_COST_STATE;
  }
}

/**
 * Resolve price copy without ever exposing the key itself.
 *
 * The defensive catches keep the disclosure truthful during a failed usage
 * read (and while component tests intentionally supply a partial API seam): a
 * generic BotMason-message statement replaces any guessed allowance.
 */
function useResonanceCost(): {
  current: ResonanceCostState;
  refresh: (_apiKey: string | null) => Promise<ResonanceCostState | null>;
} {
  const [current, setCurrent] = useState(UNKNOWN_COST_STATE);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
      generationRef.current += 1;
    },
    [],
  );

  const refresh = useCallback(async (apiKey: string | null): Promise<ResonanceCostState | null> => {
    const generation = ++generationRef.current;
    if (apiKey === null) {
      setCurrent({ ...UNKNOWN_COST_STATE, canContinue: false, loading: true });
    }
    const next = await loadCostState(apiKey);
    if (!mountedRef.current || generationRef.current !== generation) return null;
    setCurrent(next);
    return next;
  }, []);
  return useMemo(() => ({ current, refresh }), [current, refresh]);
}

/** The stored dismissal, as the gate needs to consult it. */
interface DismissedFlag {
  /** The answer if it is already in hand, or ``null`` while the read is out. */
  known: () => boolean | null;
  /** The answer, waiting for the read if it has not landed yet. */
  read: () => Promise<boolean>;
  /** Record the reader's "don’t show this again", in memory and on disk. */
  markDismissed: () => void;
}

/**
 * The stored flag, read once per mount and remembered.
 *
 * Two refs rather than one, because they answer different questions: ``settled``
 * lets a press that already has the answer act on it in the same tick, and
 * ``pending`` lets a press that does not wait for the real answer rather than
 * take a default.
 */
function useDismissedFlag(): DismissedFlag {
  const settled = useRef<boolean | null>(null);
  const pending = useRef<Promise<boolean> | null>(null);

  const read = useCallback((): Promise<boolean> => {
    pending.current ??= loadResonanceExplainerDismissed().then((stored) => {
      settled.current = stored;
      return stored;
    });
    return pending.current;
  }, []);

  // Warm the read at mount so a press is almost never the thing waiting on it.
  useEffect(() => {
    void read();
  }, [read]);

  const markDismissed = useCallback((): void => {
    // Memory first, disk after: a second press in the same session must not be
    // able to race the write and be shown the note it was just dismissed from.
    settled.current = true;
    pending.current = Promise.resolve(true);
    void saveResonanceExplainerDismissed(true);
  }, []);

  const known = useCallback((): boolean | null => settled.current, []);

  // Memoised: the entry screen re-renders on every keystroke, and an unstable
  // flag object would hand the resonance button a fresh onPress each time.
  return useMemo(() => ({ known, read, markDismissed }), [known, read, markDismissed]);
}

interface DisclosureDecisionInput {
  cost: ReturnType<typeof useResonanceCost>;
  disclosedKeyRef: MutableRefObject<string | null>;
  payerRef: MutableRefObject<{ apiKey: string | null; keyIsLoading: boolean }>;
  flag: DismissedFlag;
  runRequest: (_apiKey: string | null) => Promise<void>;
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
  if (payerKey === null && !resolvedCost.canContinue) {
    input.disclosedKeyRef.current = null;
    input.showRefill(resolvedCost.monthlyResetDate, resolvedCost.monthlyCap, 'wallet_exhausted');
  } else if (dismissed) {
    await input.runRequest(payerKey);
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
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );
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
      const task = decideOnce(() => generationRef.current === generation).finally(() => {
        if (inFlightRef.current !== task) return;
        inFlightRef.current = null;
        if (mountedRef.current) setPending(false);
      });
      inFlightRef.current = task;
      return task;
    },
    [decideOnce],
  );
  const cancel = useCallback(() => {
    generationRef.current += 1;
    inFlightRef.current = null;
    if (mountedRef.current) setPending(false);
  }, []);
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

function useFundingAwareRequest(
  requestResonance: (_apiKey: string | null) => Promise<ResonanceRequestOutcome | void>,
  cost: ReturnType<typeof useResonanceCost>,
  surfaces: ReturnType<typeof useDisclosureSurfaces>,
) {
  const generationRef = useRef(0);
  const run = useCallback(
    async (payerKey: string | null): Promise<void> => {
      const requestGeneration = ++generationRef.current;
      const outcome = await requestResonance(payerKey);
      if (
        generationRef.current !== requestGeneration ||
        (outcome !== 'funding_required' && outcome !== 'key_required')
      )
        return;
      const reason = outcome === 'key_required' ? 'key_required' : 'wallet_exhausted';
      // The server's 402 is already authoritative. Open the remedy immediately;
      // a follow-up read only refreshes the date and must never hold the dialog.
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
    [cost, requestResonance, surfaces],
  );
  const cancel = useCallback(() => {
    generationRef.current += 1;
  }, []);
  return useMemo(() => ({ run, cancel }), [run, cancel]);
}

interface ContinueInput {
  apiKey: string | null;
  keyIsLoading: boolean;
  disclosedKeyRef: MutableRefObject<string | null>;
  cost: ReturnType<typeof useResonanceCost>;
  close: () => void;
  runRequest: (_apiKey: string | null) => Promise<void>;
  showRefill: (
    _monthlyResetDate: string | null,
    _monthlyCap: number | null,
    _reason: ResonanceRefillReason,
  ) => number;
}

function useContinue(input: ContinueInput): () => void {
  const { apiKey, keyIsLoading, disclosedKeyRef, cost, close, runRequest, showRefill } = input;
  return useCallback((): void => {
    if (keyIsLoading || apiKey !== disclosedKeyRef.current) {
      disclosedKeyRef.current = apiKey;
      void cost.refresh(apiKey).then((latest) => {
        if (apiKey === null && latest !== null && !latest.canContinue) {
          showRefill(latest.monthlyResetDate, latest.monthlyCap, 'wallet_exhausted');
        }
      });
      return;
    }
    if (cost.current.loading || !cost.current.canContinue) return;
    close();
    void runRequest(disclosedKeyRef.current);
  }, [apiKey, close, cost, disclosedKeyRef, keyIsLoading, runRequest, showRefill]);
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
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const refill = useRefillSurface();
  const { onCancelRefill, showRefill: openRefill } = refill;
  const show = useCallback(() => {
    setDontShowAgain(false);
    onCancelRefill();
    setVisible(true);
  }, [onCancelRefill]);
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
  return { ...refill, visible, dontShowAgain, show, showRefill, onToggleDontShowAgain, close };
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
}

function gateFromParts(parts: GateParts): ResonanceExplainerGate {
  const { decision, surfaces, cost, onPress, onContinue, cancelPending } = parts;
  return {
    onPress,
    pending: decision.pending,
    cancelPending,
    visible: surfaces.visible,
    cost: cost.current.copy,
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
  };
}

/** Gate ``requestResonance`` behind disclosure pinned to the accepted payer. */
export function useResonanceExplainer(
  requestResonance: (_apiKey: string | null) => Promise<ResonanceRequestOutcome | void>,
): ResonanceExplainerGate {
  const { apiKey, isLoading: keyIsLoading } = useApiKey();
  const payerRef = useRef({ apiKey, keyIsLoading });
  payerRef.current = { apiKey, keyIsLoading };
  const flag = useDismissedFlag();
  const surfaces = useDisclosureSurfaces(flag);
  const cost = useResonanceCost();
  const disclosedKeyRef = useRef<string | null>(null);
  const funding = useFundingAwareRequest(requestResonance, cost, surfaces);
  const decision = useDisclosureDecision({
    cost,
    disclosedKeyRef,
    payerRef,
    flag,
    runRequest: funding.run,
    show: surfaces.show,
    showRefill: surfaces.showRefill,
  });
  const hydratedPress = useHydratedPress(decision.decide, apiKey, keyIsLoading);
  const onContinue = useContinue({
    apiKey,
    keyIsLoading,
    disclosedKeyRef,
    cost,
    close: surfaces.close,
    runRequest: funding.run,
    showRefill: surfaces.showRefill,
  });
  const cancelPending = useCancelPayerWork(
    apiKey,
    hydratedPress.cancel,
    decision.cancel,
    funding.cancel,
    surfaces.onCancelRefill,
  );

  return gateFromParts({
    decision,
    surfaces,
    cost,
    onPress: hydratedPress.onPress,
    onContinue,
    cancelPending,
  });
}
