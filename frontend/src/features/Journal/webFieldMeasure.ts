/**
 * Read a web field's content height straight off its host ``<textarea>``.
 *
 * react-native-web 0.21 measures a multiline TextInput only in its mount ref
 * callback and in its DOM ``input`` handler, so a value written from React
 * (a folded quote, a loaded entry, an appended transcript) is never measured
 * and the field keeps its old height (#3001). A growing field re-reads the
 * height here after such a write.
 *
 * Native needs none of this -- its ``onContentSizeChange`` follows every
 * value -- so off web nothing is read. A hidden or detached textarea reports
 * a ``scrollHeight`` of 0; that is no measurement, and must never collapse a
 * grown field.
 */
import { Platform } from 'react-native';

interface MeasurableHostNode {
  scrollHeight: number;
}

/** A ``scrollHeight`` that is a real, positive content height (NaN fails ``> 0``). */
function isMeasurableHeight(height: unknown): height is number {
  return typeof height === 'number' && height > 0 && height < Number.POSITIVE_INFINITY;
}

/** The web field's content height, or ``undefined`` off web or when it cannot be measured. */
export function readWebContentHeight(node: unknown): number | undefined {
  if (Platform.OS !== 'web' || node == null || typeof node !== 'object') return undefined;
  // Read once: the getter on a live textarea forces layout.
  const { scrollHeight } = node as Partial<MeasurableHostNode>;
  return isMeasurableHeight(scrollHeight) ? scrollHeight : undefined;
}
