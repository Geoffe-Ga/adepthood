/**
 * ``ManagedVaultReachability`` — "Check now" beside a managed vault (#3406).
 *
 * From 2026-10-13 to 2026-10-15 the Creek pilot was down and the managed card
 * kept saying "connected"; the only thing a writer saw was a Resonance failure
 * with a reference id. This control lets them ask whether the vault answers
 * right now, and says so in one plain sentence with the time it asked.
 *
 * **Only on a press.** Nothing here runs on mount or on a timer: every check is
 * a real handshake, and against a scale-to-zero vault a handshake can wake a
 * stopped machine. The server budgets checks per account as well; a check it
 * refuses for that budget says to wait, and claims no time it never checked.
 *
 * **Three answers, never more certainty than the server had.** A request that
 * could not be asked at all reads as "couldn't tell", the same as a check that
 * landed without settling it, because nothing showed an outage.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { settingsFormStyles } from './shared/settingsFormLayout';
import {
  VAULT_CHECKING_BUTTON,
  VAULT_CHECK_NOW_BUTTON,
  VAULT_CHECK_TOO_SOON,
  VAULT_REACHABILITY_UNKNOWN,
  VAULT_REACHABLE,
  VAULT_UNREACHABLE,
} from './vaultCopy';

import { ApiError, vault, type VaultReachabilityAnswer } from '@/api';
import { Button } from '@/components/Button';
import { SPACING } from '@/design/tokens';
import { detectDeviceTimezone, formatTimeInTZ } from '@/utils/dateUtils';

/** The status the server answers a check refused for its per-account budget with. */
const HTTP_TOO_MANY_REQUESTS = 429;

const SENTENCE_BY_STATE: Readonly<Record<VaultReachabilityAnswer['state'], string>> = {
  reachable: VAULT_REACHABLE,
  unreachable: VAULT_UNREACHABLE,
  unknown: VAULT_REACHABILITY_UNKNOWN,
};

/** What the card says after a press: a sentence, and the time only when a check ran. */
interface CheckOutcome {
  sentence: string;
  checkedAt: string | null;
}

/** "Checked 11:24 AM." in the device's own time, the moment the server asked. */
export function checkedAtSentence(checkedAt: string): string {
  return `Checked ${formatTimeInTZ(new Date(checkedAt), detectDeviceTimezone())}.`;
}

function outcomeOfFailure(error: unknown): CheckOutcome {
  const tooSoon = error instanceof ApiError && error.status === HTTP_TOO_MANY_REQUESTS;
  return { sentence: tooSoon ? VAULT_CHECK_TOO_SOON : VAULT_REACHABILITY_UNKNOWN, checkedAt: null };
}

/** One press, one request; the answer lands only while the card is still on screen. */
function useReachabilityCheck(): {
  pending: boolean;
  outcome: CheckOutcome | null;
  check: () => void;
} {
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<CheckOutcome | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const check = useCallback(() => {
    setPending(true);
    void vault.checkReachability().then(
      (answer) => {
        if (!mounted.current) return;
        setOutcome({ sentence: SENTENCE_BY_STATE[answer.state], checkedAt: answer.checked_at });
        setPending(false);
      },
      (error: unknown) => {
        if (!mounted.current) return;
        setOutcome(outcomeOfFailure(error));
        setPending(false);
      },
    );
  }, []);
  return { pending, outcome, check };
}

/** The control and, once pressed, what it found. */
export function ManagedVaultReachability(): React.JSX.Element {
  const { pending, outcome, check } = useReachabilityCheck();
  return (
    <View style={styles.container}>
      <Button
        label={pending ? VAULT_CHECKING_BUTTON : VAULT_CHECK_NOW_BUTTON}
        onPress={check}
        variant="secondary"
        busy={pending}
        disabled={pending}
        testID="vault-check-now"
        accessibilityLabel={VAULT_CHECK_NOW_BUTTON}
        style={styles.button}
      />
      {outcome ? (
        <View testID="vault-reachability-result" accessibilityLiveRegion="polite">
          <Text style={settingsFormStyles.body}>{outcome.sentence}</Text>
          {outcome.checkedAt ? (
            <Text style={settingsFormStyles.body}>{checkedAtSentence(outcome.checkedAt)}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: SPACING.lg,
  },
  button: {
    alignSelf: 'flex-start',
    marginBottom: SPACING.sm,
  },
});
