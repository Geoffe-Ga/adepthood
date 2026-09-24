import React, { useState } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { DetailPane } from './components/DetailPane';
import { InboxList } from './components/InboxList';
import * as copy from './copy';
import { triageLayoutFor } from './layout';
import { useAdminCapability, type AdminCapability } from './useAdminCapability';
import { useFeedbackDetail } from './useFeedbackDetail';
import { useFeedbackInbox } from './useFeedbackInbox';

import { Button } from '@/components/Button';
import { ScreenHeader } from '@/components/layout/ScreenHeader';
import { ScreenScaffold } from '@/components/layout/ScreenScaffold';
import { ink, rhythm, type as typeRamp } from '@/design/tokens';

/** Share of the split view the inbox list takes; the report gets the rest. */
const SPLIT_LIST_FLEX = 2;
const SPLIT_DETAIL_FLEX = 3;

/** The inbox itself, rendered only once the server has confirmed an operator. */
function Inbox(): React.JSX.Element {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  const layout = triageLayoutFor(width);
  const inbox = useFeedbackInbox();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // A change can move a report out of the active filter or reorder the list,
  // so the inbox is re-read from the top after every change that lands.
  const detail = useFeedbackDetail(selectedId, inbox.reload);

  if (layout === 'split') {
    return (
      <View style={styles.split} testID="admin-feedback-split">
        <View style={styles.listColumn}>
          <InboxList inbox={inbox} selectedId={selectedId} onSelect={setSelectedId} />
        </View>
        <View style={styles.detailColumn}>
          {selectedId === null ? (
            <Text style={[t.body, styles.hint]}>{copy.SELECT_A_REPORT}</Text>
          ) : (
            <DetailPane state={detail} />
          )}
        </View>
      </View>
    );
  }
  return (
    <View testID="admin-feedback-stacked">
      {selectedId === null ? (
        <InboxList inbox={inbox} selectedId={selectedId} onSelect={setSelectedId} />
      ) : (
        <DetailPane state={detail} onBack={() => setSelectedId(null)} />
      )}
    </View>
  );
}

interface GateProps {
  capability: AdminCapability;
  recheck: () => void;
}

/** What renders before, or instead of, the inbox. Never the inbox itself. */
function Gate({ capability, recheck }: GateProps): React.JSX.Element {
  const { width } = useWindowDimensions();
  const t = typeRamp(width);
  if (capability === 'unavailable') {
    return (
      <View testID="admin-feedback-unavailable">
        <Text style={[t.body, styles.hint]}>{copy.ACCESS_UNAVAILABLE}</Text>
        <Button
          label={copy.RETRY}
          variant="secondary"
          onPress={recheck}
          testID="admin-feedback-recheck"
        />
      </View>
    );
  }
  const message = capability === 'not-admin' ? copy.NOT_AN_OPERATOR : copy.CHECKING_ACCESS;
  return (
    <Text style={[t.body, styles.hint]} testID={`admin-feedback-${capability}`}>
      {message}
    </Text>
  );
}

/**
 * The operator's beta feedback inbox (#2900).
 *
 * Reachable only from a Settings row that itself appears only for a confirmed
 * operator -- and it asks the server again on mount, because a route can be
 * opened by a deep link as well as by a row. Until ``GET /admin/capabilities``
 * answers 200, no list is fetched and nothing admin-only is drawn; a 403 shows a
 * plain non-operator state.
 */
const AdminFeedbackScreen = (): React.JSX.Element => {
  const { capability, recheck } = useAdminCapability();
  return (
    <ScreenScaffold scroll testID="admin-feedback-screen">
      <ScreenHeader eyebrow={copy.INBOX_EYEBROW} title={copy.INBOX_TITLE} lead={copy.INBOX_LEAD} />
      {capability === 'admin' ? <Inbox /> : <Gate capability={capability} recheck={recheck} />}
    </ScreenScaffold>
  );
};

const styles = StyleSheet.create({
  split: {
    flexDirection: 'row',
    gap: rhythm.sectionGap,
  },
  listColumn: {
    flex: SPLIT_LIST_FLEX,
    minWidth: 0,
  },
  detailColumn: {
    flex: SPLIT_DETAIL_FLEX,
    minWidth: 0,
  },
  hint: {
    color: ink.soft,
    marginVertical: rhythm.blockGap,
  },
});

export default AdminFeedbackScreen;
