/**
 * ``ConnectedAgentsSection`` — "Agents that may read your vault", under "Where
 * your writing lives" in Settings (#3534).
 *
 * Every agent a person approved on the consent page (#3532) and has not
 * stopped, read once from ``GET /vault/agents``: its name, what it may do in the
 * consent page's own words, where it signs in, and when it last did. Each row
 * has a Stop control that asks in place before ``DELETE /vault/agents/{id}`` is
 * sent -- no ``window.confirm`` and no dialog, so the question renders on every
 * platform (#2928) and stays beside the agent it is about.
 *
 * **Agents arrive only through consent.** There is no "add" or "create key"
 * control here, and the empty state names the one way an agent gets onto this
 * list rather than offering a button that could not finish the job.
 *
 * **A failed read is not an empty list.** The list says it could not be read,
 * and never "no agent can read your vault", over a request that did not land --
 * the same rule the vault screen keeps for its own connection.
 *
 * **When it shows.** With a vault attached (or a read that could not tell), and
 * also for an account with nothing attached that still holds agents -- approved
 * before a disconnect -- so they can be stopped. An account with neither sees
 * nothing: an agent cannot be approved for a vault that is not there.
 *
 * The address to give an agent is the vault's ``mcp_address`` from
 * ``GET /vault/connection``, shown with a copy control exactly when the server
 * names one; a managed vault's stays private, as its ``/v1`` address does.
 *
 * The recent-activity list (#3535) renders beneath the agent rows, inside this
 * section, and reuses ``connectedAgents.lastUsedPhrase`` for its times.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';

import {
  AGENTS_ADDRESS_COPIED,
  AGENTS_ADDRESS_COPY,
  AGENTS_ADDRESS_COPY_FAILED,
  AGENTS_ADDRESS_LABEL,
  AGENTS_ADDRESS_NOTE,
  AGENTS_EMPTY,
  AGENTS_EYEBROW,
  AGENTS_HEADING,
  AGENTS_LOAD_FAILED,
  AGENTS_STOP,
  AGENTS_STOPPED,
  AGENTS_STOPPING,
  AGENTS_STOP_CONFIRM,
  AGENTS_STOP_CONFIRM_BUTTON,
  AGENTS_STOP_FAILED,
  AGENTS_STOP_KEEP,
  AGENTS_WHAT_THEY_ARE,
} from './agentsCopy';
import { agentDisplayName, grantPhrases, lastUsedPhrase, whereItSignsIn } from './connectedAgents';
import { SettingsFeedbackBanner } from './shared/SettingsFeedbackBanner';
import {
  SETTINGS_BUTTON_PADDING,
  SETTINGS_CARD_LABEL_LETTER_SPACING,
  SETTINGS_MONOSPACE_FONT,
} from './shared/settingsFormLayout';
import type { VaultConnectionState } from './vaultConnectionState';

import { vault, type ConnectedAgent } from '@/api';
import {
  BORDER_RADIUS,
  SPACING,
  accent,
  colors,
  ink,
  rhythm,
  surface,
  touchTarget,
  type as typeRamp,
} from '@/design/tokens';
import { copyToClipboard } from '@/utils/clipboard';

/** What the one read of the list found. */
type AgentList =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'loaded'; readonly agents: readonly ConnectedAgent[] };

/** The one line the section says after something a person did. */
interface Feedback {
  readonly error: string | null;
  readonly status: string | null;
}

const NO_FEEDBACK: Feedback = { error: null, status: null };

interface AgentsController {
  list: AgentList;
  feedback: Feedback;
  /** The row whose Stop question is open, if any. */
  asking: number | null;
  /** The row whose stop is on the wire, if any. */
  stopping: number | null;
  ask: (_agentId: number) => void;
  keep: () => void;
  stop: (_agentId: number) => void;
  copyAddress: (_address: string) => void;
}

/** Read the list once, on mount. A failure is its own state, never an empty list. */
function useAgentList(): [AgentList, React.Dispatch<React.SetStateAction<AgentList>>] {
  const [list, setList] = useState<AgentList>({ kind: 'loading' });
  useEffect(() => {
    let live = true;
    vault.agents().then(
      (agents) => {
        if (live) setList({ kind: 'loaded', agents });
      },
      () => {
        if (live) setList({ kind: 'failed' });
      },
    );
    return () => {
      live = false;
    };
  }, []);
  return [list, setList];
}

/** ``list`` without ``agentId``, once a stop has landed. */
function without(list: AgentList, agentId: number): AgentList {
  if (list.kind !== 'loaded') return list;
  return { kind: 'loaded', agents: list.agents.filter((agent) => agent.id !== agentId) };
}

/**
 * Everything the section renders from: the list, the open question, the stop
 * in flight, and the one feedback line.
 *
 * A row leaves the list only once the server has said yes; a stop that did not
 * land leaves the agent listed, because it still can read the vault.
 */
function useConnectedAgents(): AgentsController {
  const [list, setList] = useAgentList();
  const [feedback, setFeedback] = useState<Feedback>(NO_FEEDBACK);
  const [asking, setAsking] = useState<number | null>(null);
  const [stopping, setStopping] = useState<number | null>(null);

  const ask = useCallback((agentId: number) => {
    setAsking(agentId);
    setFeedback(NO_FEEDBACK);
  }, []);
  const keep = useCallback(() => setAsking(null), []);
  const settle = useCallback(
    (stoppedId: number | null) => {
      setAsking(null);
      setStopping(null);
      if (stoppedId === null) {
        setFeedback({ error: AGENTS_STOP_FAILED, status: null });
        return;
      }
      setList((current) => without(current, stoppedId));
      setFeedback({ error: null, status: AGENTS_STOPPED });
    },
    [setList],
  );
  const stop = useCallback(
    (agentId: number) => {
      if (stopping !== null) return;
      setStopping(agentId);
      vault.revokeAgent(agentId).then(
        () => settle(agentId),
        () => settle(null),
      );
    },
    [settle, stopping],
  );
  const copyAddress = useCallback((address: string) => {
    void copyToClipboard(address).then((copied) => {
      setFeedback(
        copied
          ? { error: null, status: AGENTS_ADDRESS_COPIED }
          : { error: AGENTS_ADDRESS_COPY_FAILED, status: null },
      );
    });
  }, []);

  return { list, feedback, asking, stopping, ask, keep, stop, copyAddress };
}

/** Whether the section has anything to say for this account. */
function sectionShows(vaultState: VaultConnectionState, list: AgentList): boolean {
  if (vaultState.kind !== 'none') return true;
  return list.kind === 'loaded' && list.agents.length > 0;
}

/** The address to give an agent, when the server named one. */
function agentAddressOf(vaultState: VaultConnectionState): string | null {
  return vaultState.kind === 'connected' ? vaultState.agentAddress : null;
}

// ---------------------------------------------------------------------------
// The pieces
// ---------------------------------------------------------------------------

const AgentAddress = ({
  address,
  onCopy,
}: {
  address: string;
  onCopy: (_address: string) => void;
}): React.JSX.Element => {
  const t = typeRamp(useWindowDimensions().width);
  return (
    <View style={styles.card} testID="vault-agents-address">
      <Text style={[t.caption, styles.cardLabel]}>{AGENTS_ADDRESS_LABEL}</Text>
      <Text style={styles.address} selectable>
        {address}
      </Text>
      <Text style={[t.caption, styles.caption]}>{AGENTS_ADDRESS_NOTE}</Text>
      <TouchableOpacity
        onPress={() => onCopy(address)}
        style={[styles.button, styles.quietButton]}
        accessibilityRole="button"
        accessibilityLabel={AGENTS_ADDRESS_COPY}
        testID="vault-agents-copy"
      >
        <Text style={styles.quietButtonText}>{AGENTS_ADDRESS_COPY}</Text>
      </TouchableOpacity>
    </View>
  );
};

interface StopQuestionProps {
  agentId: number;
  busy: boolean;
  onKeep: () => void;
  onStop: (_agentId: number) => void;
}

/** The question Stop asks, in the row, and its two answers: [keep, stop]. */
const StopQuestion = ({ agentId, busy, onKeep, onStop }: StopQuestionProps): React.JSX.Element => {
  const t = typeRamp(useWindowDimensions().width);
  return (
    <View style={styles.question} accessibilityLiveRegion="polite">
      <Text style={[t.body, styles.body]}>{AGENTS_STOP_CONFIRM}</Text>
      <View style={styles.answers}>
        <TouchableOpacity
          onPress={onKeep}
          disabled={busy}
          style={[styles.button, styles.quietButton]}
          accessibilityRole="button"
          accessibilityLabel={AGENTS_STOP_KEEP}
          accessibilityState={{ disabled: busy }}
          testID={`vault-agent-stop-keep-${agentId}`}
        >
          <Text style={styles.quietButtonText}>{AGENTS_STOP_KEEP}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => onStop(agentId)}
          disabled={busy}
          style={[styles.button, styles.destructiveButton]}
          accessibilityRole="button"
          accessibilityLabel={AGENTS_STOP_CONFIRM_BUTTON}
          accessibilityState={{ disabled: busy, busy }}
          testID={`vault-agent-stop-confirm-${agentId}`}
        >
          <Text style={styles.destructiveButtonText}>
            {busy ? AGENTS_STOPPING : AGENTS_STOP_CONFIRM_BUTTON}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

interface AgentRowProps {
  agent: ConnectedAgent;
  now: number;
  asking: boolean;
  busy: boolean;
  onAsk: (_agentId: number) => void;
  onKeep: () => void;
  onStop: (_agentId: number) => void;
}

/** One agent: who it is, what it may do, where and when it signs in, and Stop. */
const AgentRow = ({
  agent,
  now,
  asking,
  busy,
  onAsk,
  onKeep,
  onStop,
}: AgentRowProps): React.JSX.Element => {
  const t = typeRamp(useWindowDimensions().width);
  const name = agentDisplayName(agent);
  const where = whereItSignsIn(agent.redirect_host);
  return (
    <View style={styles.card} testID={`vault-agent-row-${agent.id}`}>
      <Text style={[t.label, styles.name]}>{name}</Text>
      {grantPhrases(agent.grants).map((phrase) => (
        <Text key={phrase} style={[t.body, styles.grant]}>
          {phrase}
        </Text>
      ))}
      {where === null ? null : <Text style={[t.caption, styles.caption]}>{where}</Text>}
      <Text style={[t.caption, styles.caption]}>{lastUsedPhrase(agent.last_used_at, now)}</Text>
      {asking ? (
        <StopQuestion agentId={agent.id} busy={busy} onKeep={onKeep} onStop={onStop} />
      ) : (
        <TouchableOpacity
          onPress={() => onAsk(agent.id)}
          style={[styles.button, styles.quietButton]}
          accessibilityRole="button"
          accessibilityLabel={`${AGENTS_STOP} ${name}`}
          testID={`vault-agent-stop-${agent.id}`}
        >
          <Text style={styles.quietButtonText}>{AGENTS_STOP}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
};

/** The rows, or what to say in their place. */
const AgentRows = ({ controller }: { controller: AgentsController }): React.JSX.Element => {
  const t = typeRamp(useWindowDimensions().width);
  const { list } = controller;
  if (list.kind === 'loading') {
    return (
      <View style={styles.loading} testID="vault-agents-loading">
        <ActivityIndicator />
      </View>
    );
  }
  if (list.kind === 'failed') {
    return (
      <Text style={[t.body, styles.muted]} testID="vault-agents-failed">
        {AGENTS_LOAD_FAILED}
      </Text>
    );
  }
  if (list.agents.length === 0) {
    return (
      <Text style={[t.body, styles.muted]} testID="vault-agents-empty">
        {AGENTS_EMPTY}
      </Text>
    );
  }
  const now = Date.now();
  return (
    <View testID="vault-agents-list">
      {list.agents.map((agent) => (
        <AgentRow
          key={agent.id}
          agent={agent}
          now={now}
          asking={controller.asking === agent.id}
          busy={controller.stopping === agent.id}
          onAsk={controller.ask}
          onKeep={controller.keep}
          onStop={controller.stop}
        />
      ))}
    </View>
  );
};

/** The section: heading, what an agent is, the address, the rows, the one feedback line. */
const ConnectedAgentsSection = ({
  vault: vaultState,
}: {
  vault: VaultConnectionState;
}): React.JSX.Element | null => {
  const t = typeRamp(useWindowDimensions().width);
  const controller = useConnectedAgents();
  if (!sectionShows(vaultState, controller.list)) return null;
  const address = agentAddressOf(vaultState);
  return (
    <View style={styles.section} testID="vault-agents-section">
      <Text style={[t.caption, styles.eyebrow]}>{AGENTS_EYEBROW}</Text>
      <Text style={[t.heading, styles.heading]} accessibilityRole="header">
        {AGENTS_HEADING}
      </Text>
      <Text style={[t.body, styles.body]}>{AGENTS_WHAT_THEY_ARE}</Text>
      {address === null ? null : <AgentAddress address={address} onCopy={controller.copyAddress} />}
      <AgentRows controller={controller} />
      <SettingsFeedbackBanner
        idPrefix="vault-agents"
        error={controller.feedback.error}
        status={controller.feedback.status}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  section: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: surface.hairline,
    paddingTop: rhythm.sectionGap,
    marginBottom: SPACING.xl,
  },
  eyebrow: {
    color: accent.primary,
    textTransform: 'uppercase',
    letterSpacing: SETTINGS_CARD_LABEL_LETTER_SPACING,
    marginBottom: rhythm.blockGap,
  },
  heading: {
    color: ink.primary,
    marginBottom: rhythm.blockGap,
  },
  body: {
    color: ink.primary,
    marginBottom: rhythm.blockGap,
  },
  muted: {
    color: ink.muted,
    marginBottom: SPACING.xl,
  },
  caption: {
    color: ink.soft,
    marginBottom: SPACING.sm,
  },
  loading: {
    alignItems: 'center',
    paddingVertical: rhythm.sectionGap,
  },
  card: {
    borderWidth: 1,
    borderColor: surface.hairline,
    borderRadius: BORDER_RADIUS.lg,
    padding: SPACING.lg,
    marginBottom: SPACING.lg,
    backgroundColor: surface.raised,
  },
  cardLabel: {
    color: ink.muted,
    textTransform: 'uppercase',
    letterSpacing: SETTINGS_CARD_LABEL_LETTER_SPACING,
  },
  address: {
    fontSize: 16,
    fontFamily: SETTINGS_MONOSPACE_FONT,
    marginTop: SPACING.sm,
    marginBottom: SPACING.md,
    color: ink.primary,
  },
  name: {
    color: ink.primary,
    marginBottom: SPACING.sm,
  },
  grant: {
    color: ink.primary,
    marginBottom: SPACING.xs,
  },
  question: {
    marginTop: SPACING.md,
  },
  answers: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.md,
  },
  button: {
    borderRadius: BORDER_RADIUS.md,
    padding: SETTINGS_BUTTON_PADDING,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: touchTarget.minimum,
    alignSelf: 'flex-start',
    marginTop: SPACING.sm,
  },
  quietButton: {
    borderWidth: 1,
    borderColor: surface.hairline,
    backgroundColor: surface.sunken,
  },
  quietButtonText: { color: ink.primary, fontWeight: '600', fontSize: 16 },
  destructiveButton: {
    backgroundColor: colors.destructive.background,
    borderWidth: 1,
    borderColor: colors.destructive.border,
  },
  destructiveButtonText: { color: colors.destructive.text, fontWeight: '600', fontSize: 16 },
});

export default ConnectedAgentsSection;
