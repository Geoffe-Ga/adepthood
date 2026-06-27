/**
 * Read-mode rendering of an entry body with each anchored span softly
 * highlighted and tappable. The offset math lives in {@link buildHighlightSegments};
 * this only maps segments to a composed ``<Text>`` tree.
 */
import React from 'react';
import { StyleSheet, Text } from 'react-native';

import { buildHighlightSegments } from './highlightSegments';

import type { Marginalia } from '@/api';
import { colors, editorialType } from '@/design/tokens';

export interface HighlightedBodyProps {
  body: string;
  notes: Marginalia[];
  onOpen: (_note: Marginalia) => void;
}

function HighlightedBody({ body, notes, onOpen }: HighlightedBodyProps): React.JSX.Element {
  const segments = buildHighlightSegments(body, notes);
  return (
    <Text style={styles.body} testID="journal-body-read">
      {segments.map((segment) => {
        const { note } = segment;
        if (note == null) return segment.text;
        return (
          <Text
            key={segment.start}
            style={[styles.highlight, { color: colors.marginalia[note.kind] }]}
            onPress={() => onOpen(note)}
            accessibilityRole="link"
            accessibilityLabel={`Highlighted ${note.kind} passage`}
            testID={`highlight-${note.id}`}
          >
            {segment.text}
          </Text>
        );
      })}
    </Text>
  );
}

const styles = StyleSheet.create({
  body: {
    ...editorialType.body,
    color: colors.paper.ink,
  },
  highlight: {
    // Soft paper-toned wash; the kind colour comes from the inline text colour so
    // there are no colour literals here.
    backgroundColor: colors.paper.anchorHighlight,
    fontWeight: '600',
  },
});

export default HighlightedBody;
