import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import InferenceReceiptDetails from './InferenceReceiptDetails';
import { isDemoSource, sourceLabel } from './sourceLabel';
import { vaultKeyReceiptLabel } from './vaultKeyCopy';

import type { PassProvenanceT } from '@/api/schemas';
import { colors, editorialType, spacing } from '@/design/tokens';

type OperationReceipt = PassProvenanceT['notes'];

const payerLabels = {
  own_key: 'Your provider key',
  wallet: 'Adepthood wallet',
  free: 'No Adepthood wallet charge',
} as const;

const unrecordedPass: PassProvenanceT = {
  notes: null,
  detection: null,
  detection_checked: null,
  paid_by: null,
  own_key_vendor: null,
};

/** Who paid, named per use: a vault that wrote with the writer's key says whose (#3437). */
function payerLabel(receipt: PassProvenanceT): string {
  const { paid_by: payer, own_key_vendor: vendor } = receipt;
  if (payer == null) return 'Payment route not recorded';
  if (payer === 'own_key' && vendor) return vaultKeyReceiptLabel(vendor);
  return payerLabels[payer];
}

function completionStatus(receipt: OperationReceipt, checked: boolean | null): string | null {
  if (receipt?.source === 'none') return null;
  if (checked === true) return 'Check completion reported.';
  if (checked == null) return 'Check completion not recorded.';
  return receipt
    ? 'A check was attempted; completion was not confirmed.'
    : 'Check completion was not confirmed.';
}

function OperationIdentity({
  title,
  receipt,
  sourceTestId,
}: {
  title: 'Notes' | 'Completion check';
  receipt: OperationReceipt;
  sourceTestId: string;
}): React.JSX.Element {
  const notRun =
    title === 'Notes' ? 'No notes operation was run.' : 'No AI completion check was sent.';
  return (
    <View>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.caption} testID={sourceTestId}>
        {receipt?.source === 'none' ? notRun : sourceLabel(receipt?.source)}
      </Text>
      {receipt && receipt.source !== 'none' ? (
        <InferenceReceiptDetails
          provider={receipt.provider}
          model={receipt.model}
          style={styles.caption}
        />
      ) : null}
    </View>
  );
}

/** Only the current pass supplies its payment route; persisted notes supply no billing history. */
export default function PassReceiptNotice({
  provenance,
  empty,
}: {
  provenance: PassProvenanceT | null | undefined;
  empty: boolean;
}): React.JSX.Element | null {
  if (provenance === undefined) return null;
  const receipt = provenance ?? unrecordedPass;
  const { notes, detection } = receipt;
  const status = completionStatus(detection, receipt.detection_checked);
  return (
    <View style={styles.receipt} testID="resonance-pass-receipt" accessibilityLiveRegion="polite">
      <OperationIdentity
        title="Notes"
        receipt={notes}
        sourceTestId={
          empty || isDemoSource(notes?.source) ? 'resonance-pass-source' : 'resonance-notes-source'
        }
      />
      <OperationIdentity
        title="Completion check"
        receipt={detection}
        sourceTestId="resonance-completion-source"
      />
      {status ? <Text style={styles.caption}>{status}</Text> : null}
      <View>
        <Text style={styles.title}>Payment route</Text>
        <Text style={styles.caption} testID="resonance-pass-payer">
          {payerLabel(receipt)}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  receipt: { gap: spacing(1), marginBottom: spacing(1) },
  title: { ...editorialType.caption, color: colors.paper.inkSoft, fontWeight: '600' },
  caption: { ...editorialType.caption, color: colors.paper.inkSoft },
});
