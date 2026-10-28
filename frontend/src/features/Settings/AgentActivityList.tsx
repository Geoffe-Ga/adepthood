/**
 * ``AgentActivityList`` — "Recent activity", beneath the agents a person approved
 * in "Agents that may read your vault" (#3535).
 *
 * Up to twenty of the vault's most recent calls, read from
 * ``GET /vault/agents/activity``: who asked, what for, how long ago, and a small
 * "Refused" beside a call the vault turned down before it ran. Every word in a
 * row but the time is the server's -- an agent's own name or adepthood's plain
 * phrase for a tool -- and none of it can be what was asked or what came back,
 * because the route carries four fields and no more.
 *
 * **Twenty rows, not a log viewer.** No paging, no filters, no detail view: the
 * list is there so a person can judge an agent at a glance and stop it with a
 * reason.
 *
 * **Read on arrival and on return, never polled.** The list is read when the
 * screen mounts and again whenever it regains focus (``useRefetchOnFocus``),
 * and at no other time.
 *
 * **A vault that could not be read is not a quiet one.** The server answers
 * ``unavailable`` for every way it could not look, and so does a request that
 * did not land; both say Adepthood could not check, never "nothing yet".
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import {
  ACTIVITY_EMPTY,
  ACTIVITY_HEADING,
  ACTIVITY_REFUSED,
  ACTIVITY_UNAVAILABLE,
  ACTIVITY_WHAT_IT_IS,
} from './agentsCopy';
import { whenPhrase } from './connectedAgents';
import { SETTINGS_CARD_LABEL_LETTER_SPACING } from './shared/settingsFormLayout';

import { vault, type AgentActivityRow } from '@/api';
import { BORDER_RADIUS, SPACING, ink, rhythm, surface, type as typeRamp } from '@/design/tokens';
import { useRefetchOnFocus } from '@/hooks/useRefetchOnFocus';

/** The most calls the list shows, and so the most it asks the server for. */
export const ACTIVITY_ROW_LIMIT = 20;

/** What the latest read of the activity found. */
type ActivityList =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'loaded'; readonly rows: readonly AgentActivityRow[] };

/**
 * Read the list on mount and on every return to the screen.
 *
 * A read already showing rows keeps them on screen while the next one is in
 * flight, so returning to Settings does not flash a spinner over a list that is
 * about to come back the same. Only the latest read may settle the list.
 */
function useAgentActivity(): ActivityList {
  const [list, setList] = useState<ActivityList>({ kind: 'loading' });
  const latest = useRef(0);
  const read = useCallback(() => {
    latest.current += 1;
    const ticket = latest.current;
    const settle = (next: ActivityList): void => {
      if (ticket === latest.current) setList(next);
    };
    vault.agentActivity(ACTIVITY_ROW_LIMIT).then(
      (answer) =>
        settle(
          answer.status === 'ok'
            ? { kind: 'loaded', rows: answer.rows.slice(0, ACTIVITY_ROW_LIMIT) }
            : { kind: 'unavailable' },
        ),
      () => settle({ kind: 'unavailable' }),
    );
  }, []);
  useEffect(() => {
    read();
    return () => {
      // Any read still in flight belongs to a list that is no longer on screen.
      latest.current += 1;
    };
  }, [read]);
  useRefetchOnFocus(read);
  return list;
}

/** One call: who, what, when, and whether it was turned away. */
const ActivityRow = ({
  row,
  index,
  now,
}: {
  row: AgentActivityRow;
  index: number;
  now: number;
}): React.JSX.Element => {
  const t = typeRamp(useWindowDimensions().width);
  const when = whenPhrase(row.at, now);
  const refused = row.outcome === 'refused';
  return (
    <View style={styles.row} testID={`vault-activity-row-${index}`}>
      <View style={styles.rowText}>
        <Text style={[t.body, styles.what]}>{row.tool_label}</Text>
        <Text style={[t.caption, styles.who]}>
          {when === null ? row.agent : `${row.agent} · ${when}`}
        </Text>
      </View>
      {refused ? (
        <Text
          style={[t.caption, styles.refused]}
          testID={`vault-activity-refused-${index}`}
          accessibilityLabel={ACTIVITY_REFUSED}
        >
          {ACTIVITY_REFUSED}
        </Text>
      ) : null}
    </View>
  );
};

/** The rows, or what to say in their place. */
const ActivityBody = ({ list }: { list: ActivityList }): React.JSX.Element => {
  const t = typeRamp(useWindowDimensions().width);
  if (list.kind === 'loading') {
    return (
      <View style={styles.loading} testID="vault-activity-loading">
        <ActivityIndicator />
      </View>
    );
  }
  if (list.kind === 'unavailable') {
    return (
      <Text style={[t.body, styles.muted]} testID="vault-activity-unavailable">
        {ACTIVITY_UNAVAILABLE}
      </Text>
    );
  }
  if (list.rows.length === 0) {
    return (
      <Text style={[t.body, styles.muted]} testID="vault-activity-empty">
        {ACTIVITY_EMPTY}
      </Text>
    );
  }
  const now = Date.now();
  return (
    <View style={styles.list} testID="vault-activity-list">
      {list.rows.map((row, index) => (
        <ActivityRow key={`${row.at}-${index}`} row={row} index={index} now={now} />
      ))}
    </View>
  );
};

/** "Recent activity": the heading, the one line, and the rows. */
const AgentActivityList = (): React.JSX.Element => {
  const t = typeRamp(useWindowDimensions().width);
  const list = useAgentActivity();
  return (
    <View style={styles.section} testID="vault-activity">
      <Text style={[t.caption, styles.heading]} accessibilityRole="header">
        {ACTIVITY_HEADING}
      </Text>
      <Text style={[t.caption, styles.caption]}>{ACTIVITY_WHAT_IT_IS}</Text>
      <ActivityBody list={list} />
    </View>
  );
};

const styles = StyleSheet.create({
  section: {
    marginTop: SPACING.md,
    marginBottom: SPACING.lg,
  },
  heading: {
    color: ink.muted,
    textTransform: 'uppercase',
    letterSpacing: SETTINGS_CARD_LABEL_LETTER_SPACING,
    marginBottom: SPACING.xs,
  },
  caption: {
    color: ink.soft,
    marginBottom: rhythm.blockGap,
  },
  muted: {
    color: ink.muted,
  },
  loading: {
    alignItems: 'center',
    paddingVertical: SPACING.lg,
  },
  list: {
    borderWidth: 1,
    borderColor: surface.hairline,
    borderRadius: BORDER_RADIUS.lg,
    backgroundColor: surface.raised,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SPACING.md,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: surface.hairline,
  },
  rowText: {
    flex: 1,
  },
  what: {
    color: ink.primary,
  },
  who: {
    color: ink.soft,
  },
  // Quiet on purpose: a refusal is the vault doing its job, not an alarm.
  refused: {
    color: ink.muted,
    backgroundColor: surface.sunken,
    borderWidth: 1,
    borderColor: surface.hairline,
    borderRadius: BORDER_RADIUS.sm,
    paddingHorizontal: SPACING.xs,
    alignSelf: 'center',
  },
});

export default AgentActivityList;
