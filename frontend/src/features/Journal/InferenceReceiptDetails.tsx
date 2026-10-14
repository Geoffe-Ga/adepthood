import React from 'react';
import { Platform, Text, View, type StyleProp, type TextStyle } from 'react-native';

import type { PassProvenanceT } from '@/api/schemas';

type Provider = NonNullable<NonNullable<PassProvenanceT['notes']>['provider']>;

const providerNames: Record<Provider, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  creek: 'Creek',
  stub: 'Demo',
};

/** Reported identity is disclosure, never evidence of a local model or attestation. */
export default function InferenceReceiptDetails({
  provider,
  model,
  style,
}: {
  provider?: Provider | null;
  model?: string | null;
  style: StyleProp<TextStyle>;
}): React.JSX.Element {
  return (
    <View>
      <Text style={style}>
        {provider == null
          ? 'Provider not recorded'
          : `Reported provider: ${providerNames[provider]}`}
      </Text>
      <Text style={[style, modelWrap]}>
        {model ? `Reported model: ${model}` : 'Model not recorded'}
      </Text>
    </View>
  );
}

// Provider identifiers can be a single long token; web text must wrap inside the margin.
const modelWrap = Platform.OS === 'web' ? ({ overflowWrap: 'anywhere' } as TextStyle) : undefined;
