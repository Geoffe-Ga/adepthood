import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import * as copy from '../copy';

import { adminFeedback, type FeedbackIssueDraftT, type FeedbackOperatorNoteT } from '@/api';
import { Button } from '@/components/Button';
import { TextField } from '@/components/TextField';
import { useAuth } from '@/context/AuthContext';
import {
  accent,
  ink,
  radius,
  rhythm,
  surface,
  touchTarget,
  type as typeRamp,
} from '@/design/tokens';
import { saveTextFile } from '@/features/Settings/saveDataExport';
import { copyToClipboard } from '@/utils/clipboard';

interface DraftPanelProps {
  publicId: string;
  notes: FeedbackOperatorNoteT[];
}

/** The filename a downloaded draft is saved under. */
export function draftFilename(publicId: string): string {
  return `${publicId}-issue-draft.md`;
}

function draftText(draft: FeedbackIssueDraftT): string {
  return `# ${draft.title}\n\n${draft.markdown}`;
}

interface NoteToggleProps {
  note: FeedbackOperatorNoteT;
  checked: boolean;
  onToggle: () => void;
}

function NoteToggle({ note, checked, onToggle }: NoteToggleProps): React.JSX.Element {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={copy.DRAFT_INCLUDE_NOTE(note.id)}
      onPress={onToggle}
      style={[styles.toggle, checked && styles.toggleChecked]}
      testID={`draft-note-${note.id}`}
    >
      <Text style={[t.body, styles.toggleText]} numberOfLines={2}>
        {note.body}
      </Text>
    </Pressable>
  );
}

interface DraftState extends OperatorText {
  selected: ReadonlySet<number>;
  toggle: (_id: number) => void;
  draft: FeedbackIssueDraftT | null;
  busy: boolean;
  message: string | null;
  prepare: () => void;
  copyDraft: (_draft: FeedbackIssueDraftT) => void;
  downloadDraft: (_draft: FeedbackIssueDraftT) => void;
}

interface OperatorText {
  title: string;
  setTitle: (_value: string) => void;
  summary: string;
  setSummary: (_value: string) => void;
  ready: boolean;
}

/**
 * The operator's own title and summary, and nothing else.
 *
 * Deliberately never seeded from the report: the reporter's words are shown
 * above for reference only and must never find their way into a draft that
 * may be posted publicly.
 */
function useOperatorText(): OperatorText {
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const ready = title.trim() !== '' && summary.trim() !== '';
  return { title, setTitle, summary, setSummary, ready };
}

/** The draft panel's state: which notes are ticked, the draft, and the handoffs. */
function useDraft(publicId: string): DraftState {
  const { token } = useAuth();
  const operator = useOperatorText();
  const { title, summary, ready } = operator;
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [draft, setDraft] = useState<FeedbackIssueDraftT | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const toggle = (id: number): void => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const prepare = (): void => {
    if (!ready) return;
    setBusy(true);
    setMessage(null);
    adminFeedback
      .draft(publicId, { title, summary, noteIds: [...selected] }, token ?? undefined)
      .then(setDraft)
      .catch(() => setMessage(copy.DRAFT_FAILED))
      .finally(() => setBusy(false));
  };

  const copyDraft = (current: FeedbackIssueDraftT): void => {
    void copyToClipboard(draftText(current)).then((ok) =>
      setMessage(ok ? copy.COPIED : copy.COPY_FAILED),
    );
  };

  const downloadDraft = (current: FeedbackIssueDraftT): void => {
    const filename = draftFilename(publicId);
    void saveTextFile(filename, draftText(current), copy.DRAFT_MEDIA_TYPE)
      .then(() => setMessage(copy.DOWNLOADED(filename)))
      .catch(() => setMessage(copy.DRAFT_FAILED));
  };

  return {
    ...operator,
    selected,
    toggle,
    draft,
    busy,
    message,
    prepare,
    copyDraft,
    downloadDraft,
  };
}

/** The two fields the operator writes the draft's prose in. Empty until they type. */
function OperatorFields({ text }: { text: OperatorText }): React.JSX.Element {
  return (
    <>
      <TextField
        value={text.title}
        onChangeText={text.setTitle}
        accessibilityLabel={copy.DRAFT_TITLE_LABEL}
        placeholder={copy.DRAFT_TITLE_LABEL}
        style={styles.field}
        testID="draft-operator-title"
      />
      <TextField
        value={text.summary}
        onChangeText={text.setSummary}
        accessibilityLabel={copy.DRAFT_SUMMARY_LABEL}
        placeholder={copy.DRAFT_SUMMARY_LABEL}
        multiline
        style={styles.field}
        testID="draft-operator-summary"
      />
    </>
  );
}

/** The rendered draft, with exactly two ways out: copy it, or download it. */
function DraftPreview({
  draft,
  onCopy,
  onDownload,
}: {
  draft: FeedbackIssueDraftT;
  onCopy: () => void;
  onDownload: () => void;
}): React.JSX.Element {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  return (
    <View style={styles.preview} testID="draft-preview">
      <Text style={[t.label, styles.previewTitle]} selectable>
        {draft.title}
      </Text>
      <Text style={[t.body, styles.previewBody]} selectable>
        {draft.markdown}
      </Text>
      <View style={styles.row}>
        <Button label={copy.COPY_DRAFT} variant="secondary" onPress={onCopy} testID="draft-copy" />
        <Button
          label={copy.DOWNLOAD_DRAFT}
          variant="secondary"
          onPress={onDownload}
          testID="draft-download"
        />
      </View>
    </View>
  );
}

/**
 * Prepare a GitHub issue draft from the open report, then copy or download it.
 *
 * There is deliberately no third button. Publishing is a human decision made in
 * the tracker, with the draft in hand; this panel never talks to GitHub, and the
 * route behind it makes no outbound call either. The draft is the operator's
 * own title and summary plus listed non-identifying details; the reporter's
 * words are never in it. A note is quoted only when its box is ticked -- the
 * default is none.
 */
export function DraftPanel({ publicId, notes }: DraftPanelProps): React.JSX.Element {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  const state = useDraft(publicId);
  const { draft } = state;
  return (
    <View style={styles.panel} testID="draft-panel">
      <Text style={[t.heading, styles.heading]} accessibilityRole="header">
        {copy.DRAFT_HEADING}
      </Text>
      <Text style={[t.caption, styles.explainer]}>{copy.DRAFT_EXPLAINER}</Text>
      <OperatorFields text={state} />
      {notes.map((note) => (
        <NoteToggle
          key={note.id}
          note={note}
          checked={state.selected.has(note.id)}
          onToggle={() => state.toggle(note.id)}
        />
      ))}
      <Button
        label={copy.GENERATE_DRAFT}
        disabled={!state.ready}
        busy={state.busy}
        onPress={state.prepare}
        testID="draft-generate"
      />
      {draft ? (
        <DraftPreview
          draft={draft}
          onCopy={() => state.copyDraft(draft)}
          onDownload={() => state.downloadDraft(draft)}
        />
      ) : null}
      {state.message ? (
        <Text style={[t.caption, styles.message]} accessibilityLiveRegion="polite">
          {state.message}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    marginBottom: rhythm.sectionGap,
  },
  heading: {
    color: ink.primary,
    marginBottom: rhythm.blockGap,
  },
  field: {
    minHeight: touchTarget.minimum,
    marginBottom: rhythm.blockGap,
  },
  explainer: {
    color: ink.soft,
    marginBottom: rhythm.blockGap,
  },
  toggle: {
    minHeight: touchTarget.minimum,
    justifyContent: 'center',
    borderColor: surface.hairline,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.sm,
    paddingHorizontal: rhythm.blockGap,
    marginBottom: rhythm.blockGap,
  },
  toggleChecked: {
    borderColor: accent.primary,
    backgroundColor: surface.sunken,
  },
  toggleText: {
    color: ink.primary,
  },
  preview: {
    backgroundColor: surface.sunken,
    borderRadius: radius.md,
    padding: rhythm.blockGap,
    marginTop: rhythm.blockGap,
  },
  previewTitle: {
    color: ink.primary,
    marginBottom: rhythm.blockGap,
  },
  previewBody: {
    color: ink.primary,
    marginBottom: rhythm.blockGap,
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: rhythm.blockGap,
  },
  message: {
    color: ink.soft,
    marginTop: rhythm.blockGap,
  },
});
