import React from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import * as copy from '../copy';
import type { FeedbackDetailState } from '../useFeedbackDetail';

import { DraftPanel } from './DraftPanel';
import { EvidenceField, EvidenceSection } from './EvidenceSection';
import { TriageActions } from './TriageActions';

import type { FeedbackTriageDetailT } from '@/api';
import { Button } from '@/components/Button';
import { ink, rhythm, type as typeRamp } from '@/design/tokens';

function shown(value: string | null): string {
  return value === null || value.trim() === '' ? copy.NOT_PROVIDED : value;
}

function listed(values: readonly string[]): string {
  return values.length === 0 ? copy.NONE : values.join(', ');
}

/** The tester's own words, and nothing else. */
function ReporterSaid({ detail }: { detail: FeedbackTriageDetailT }): React.JSX.Element {
  const said = detail.reporter_said;
  return (
    <EvidenceSection title={copy.SECTION_REPORTER_SAID} testID="evidence-reporter-said">
      <EvidenceField label={copy.LABEL_SUMMARY} value={said.summary} />
      <EvidenceField label={copy.LABEL_INTENT} value={shown(said.intent)} />
      <EvidenceField label={copy.LABEL_EXPECTED} value={shown(said.expected)} />
      <EvidenceField label={copy.LABEL_ACTUAL} value={shown(said.actual)} />
    </EvidenceSection>
  );
}

/** The allowlisted envelope the client attached. */
function AppAttached({ detail }: { detail: FeedbackTriageDetailT }): React.JSX.Element {
  const attached = detail.app_attached;
  return (
    <EvidenceSection title={copy.SECTION_APP_ATTACHED} testID="evidence-app-attached">
      <EvidenceField label={copy.LABEL_SCREEN} value={attached.screen} />
      <EvidenceField label={copy.LABEL_CONTROL} value={shown(attached.control)} />
      <EvidenceField label={copy.LABEL_PLATFORM} value={attached.platform} />
      <EvidenceField label={copy.LABEL_BUILD} value={attached.app_build} />
      <EvidenceField label={copy.LABEL_VIEWPORT} value={attached.viewport_class} />
      <EvidenceField label={copy.LABEL_LOCALE} value={shown(attached.locale)} />
      <EvidenceField label={copy.LABEL_CORRELATION} value={shown(attached.correlation_id)} />
      <EvidenceField label={copy.LABEL_FILED} value={attached.created_at} />
    </EvidenceSection>
  );
}

/** Everything operators added: state, links, notes, the trail, and the controls. */
function OperatorAdded({ state }: { state: FeedbackDetailState }): React.JSX.Element | null {
  const { detail } = state;
  if (detail === null) return null;
  const added = detail.operator_added;
  return (
    <EvidenceSection title={copy.SECTION_OPERATOR_ADDED} testID="evidence-operator-added">
      <EvidenceField label={copy.LABEL_STATUS} value={added.status} testID="operator-status" />
      <EvidenceField label={copy.LABEL_DUPLICATE_OF} value={added.duplicate_of ?? copy.NONE} />
      <EvidenceField label={copy.LABEL_DUPLICATES} value={listed(added.duplicates)} />
      <EvidenceField
        label={copy.LABEL_NOTES}
        value={listed(added.notes.map((note) => note.body))}
        testID="operator-notes"
      />
      <EvidenceField
        label={copy.LABEL_TRAIL}
        value={listed(
          added.events.map(
            (event) =>
              `${event.action} ${event.old_state ?? '—'} → ${event.new_state ?? '—'} (${event.created_at})`,
          ),
        )}
      />
      <TriageActions
        detail={detail}
        busy={state.busy}
        onTransition={state.transition}
        onLinkDuplicate={state.linkDuplicate}
        onUnlinkDuplicate={state.unlinkDuplicate}
        onAddNote={state.addNote}
      />
      {state.actionFailed ? (
        <Text style={styles.warning} accessibilityLiveRegion="polite">
          {copy.ACTION_FAILED}
        </Text>
      ) : null}
    </EvidenceSection>
  );
}

/** Reports sharing the fingerprint. Suggestions to read, never a merge. */
function Siblings({ detail }: { detail: FeedbackTriageDetailT }): React.JSX.Element {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  return (
    <View style={styles.siblings} testID="detail-siblings">
      <Text style={[t.label, styles.siblingsTitle]} accessibilityRole="header">
        {copy.SECTION_SIBLINGS}
      </Text>
      <Text style={[t.caption, styles.siblingsBody]}>
        {detail.siblings.length === 0
          ? copy.NO_SIBLINGS
          : listed(detail.siblings.map((sibling) => `${sibling.public_id} (${sibling.status})`))}
      </Text>
    </View>
  );
}

interface DetailPaneProps {
  state: FeedbackDetailState;
  onBack?: () => void;
}

/** The open report: three evidence sections kept apart, then the draft panel. */
export function DetailPane({ state, onBack }: DetailPaneProps): React.JSX.Element {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  const { detail } = state;
  return (
    <View testID="detail-pane">
      {onBack ? (
        <Button
          label={copy.BACK_TO_INBOX}
          variant="tertiary"
          onPress={onBack}
          testID="detail-back"
        />
      ) : null}
      {state.failed ? (
        <View>
          <Text style={[t.body, styles.warning]}>{copy.LOAD_FAILED}</Text>
          <Button
            label={copy.RETRY}
            variant="secondary"
            onPress={state.reload}
            testID="detail-retry"
          />
        </View>
      ) : null}
      {detail ? (
        <>
          <Text style={[t.title, styles.reference]} accessibilityRole="header">
            {detail.public_id}
          </Text>
          <ReporterSaid detail={detail} />
          <AppAttached detail={detail} />
          <OperatorAdded state={state} />
          <Siblings detail={detail} />
          <DraftPanel publicId={detail.public_id} notes={detail.operator_added.notes} />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  reference: {
    color: ink.primary,
    marginBottom: rhythm.blockGap,
  },
  warning: {
    color: ink.soft,
    marginVertical: rhythm.blockGap,
  },
  siblings: {
    marginBottom: rhythm.sectionGap,
  },
  siblingsTitle: {
    color: ink.primary,
    marginBottom: rhythm.blockGap,
  },
  siblingsBody: {
    color: ink.soft,
  },
});
