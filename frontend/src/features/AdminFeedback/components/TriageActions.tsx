import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import * as copy from '../copy';

import type { FeedbackStatusT, FeedbackTriageDetailT } from '@/api';
import { Button } from '@/components/Button';
import { TextField } from '@/components/TextField';
import { rhythm, touchTarget } from '@/design/tokens';

interface TriageActionsProps {
  detail: FeedbackTriageDetailT;
  busy: boolean;
  onTransition: (_status: FeedbackStatusT) => unknown;
  onLinkDuplicate: (_target: string) => unknown;
  onUnlinkDuplicate: () => unknown;
  onAddNote: (_body: string) => Promise<boolean>;
}

interface StatusButtonsProps {
  detail: FeedbackTriageDetailT;
  busy: boolean;
  onTransition: (_status: FeedbackStatusT) => unknown;
}

/** One button per status the server says this report may move to next. */
function StatusButtons({ detail, busy, onTransition }: StatusButtonsProps): React.JSX.Element {
  return (
    <View style={styles.row}>
      {detail.allowed_transitions.map((status) => (
        <Button
          key={status}
          label={copy.MOVE_TO(status)}
          variant="secondary"
          busy={busy}
          onPress={() => onTransition(status)}
          testID={`triage-transition-${status}`}
          style={styles.action}
        />
      ))}
    </View>
  );
}

interface DuplicateControlsProps {
  linked: boolean;
  busy: boolean;
  onLinkDuplicate: (_target: string) => unknown;
  onUnlinkDuplicate: () => unknown;
}

/** Link the report to its canonical one by reference, or clear the link. */
function DuplicateControls({
  linked,
  busy,
  onLinkDuplicate,
  onUnlinkDuplicate,
}: DuplicateControlsProps): React.JSX.Element {
  const [target, setTarget] = useState('');
  return (
    <>
      <TextField
        value={target}
        onChangeText={setTarget}
        accessibilityLabel={copy.DUPLICATE_TARGET_LABEL}
        placeholder={copy.DUPLICATE_TARGET_LABEL}
        autoCapitalize="characters"
        style={styles.field}
        testID="triage-duplicate-target"
      />
      <View style={styles.row}>
        <Button
          label={copy.LINK_DUPLICATE}
          variant="secondary"
          disabled={target.trim() === ''}
          busy={busy}
          onPress={() => onLinkDuplicate(target.trim())}
          testID="triage-link-duplicate"
          style={styles.action}
        />
        {linked ? (
          <Button
            label={copy.UNLINK_DUPLICATE}
            variant="tertiary"
            busy={busy}
            onPress={onUnlinkDuplicate}
            testID="triage-unlink-duplicate"
            style={styles.action}
          />
        ) : null}
      </View>
    </>
  );
}

/** Write one private note. */
function NoteComposer({
  busy,
  onAddNote,
}: {
  busy: boolean;
  onAddNote: (_body: string) => Promise<boolean>;
}): React.JSX.Element {
  const [note, setNote] = useState('');
  return (
    <>
      <TextField
        value={note}
        onChangeText={setNote}
        accessibilityLabel={copy.NOTE_FIELD_LABEL}
        placeholder={copy.NOTE_FIELD_LABEL}
        multiline
        style={styles.field}
        testID="triage-note-body"
      />
      <Button
        label={copy.ADD_NOTE}
        disabled={note.trim() === ''}
        busy={busy}
        onPress={() => {
          // Cleared only once the server has the note: a refused or lost save
          // leaves the operator's words where they typed them.
          void onAddNote(note).then((saved) => {
            if (saved) setNote('');
          });
        }}
        testID="triage-add-note"
        style={styles.action}
      />
    </>
  );
}

/**
 * The operator's controls. The status buttons are exactly the server's
 * ``allowed_transitions`` -- the client keeps no copy of the state machine, so
 * it can never offer a move the server would refuse.
 */
export function TriageActions({
  detail,
  busy,
  onTransition,
  onLinkDuplicate,
  onUnlinkDuplicate,
  onAddNote,
}: TriageActionsProps): React.JSX.Element {
  return (
    <View testID="triage-actions">
      <StatusButtons detail={detail} busy={busy} onTransition={onTransition} />
      <DuplicateControls
        linked={detail.operator_added.duplicate_of !== null}
        busy={busy}
        onLinkDuplicate={onLinkDuplicate}
        onUnlinkDuplicate={onUnlinkDuplicate}
      />
      <NoteComposer busy={busy} onAddNote={onAddNote} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: rhythm.blockGap,
    marginBottom: rhythm.blockGap,
  },
  action: {
    minHeight: touchTarget.minimum,
  },
  field: {
    minHeight: touchTarget.minimum,
    marginBottom: rhythm.blockGap,
  },
});
